import { ShapeSource, SyncPolicy } from "@smthrs/effect-electric"
import { Outbox } from "@smthrs/effect-tanstack-db"
import { Effect, Metric } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { failingWorker, nodeDevice, openFaultyApp, type TabOptions, TestChatApi } from "../../test/chatApi"
import { QuestionFaults } from "../../test/faults"
import { read } from "../../test/otlp"
import { Chat } from "./chat"
import { ChatStore } from "./store"
import { SHAPE_ROUTE } from "./contract"

// Every browser record docs/observability.md lists for chat, read back from the OTLP exports the browser sent
// ChatApi's relay, attribute by attribute. A sentinel in what people write appears in none of them. The app's own
// records (boot, page errors, reload) are in src/boot.test.ts.

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void, timeout = 4_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/**
 * A tab on its own ChatApi, with the faulty ChatApi client and shape source so a test can fail one ask or one sync.
 * `exported` closes every runtime, which flushes the exporter, and reads the exports.
 */
const open = async (options: TabOptions = {}) => {
  const runtime = openFaultyApp(options)
  runtimes.push(runtime)
  const chat = await runtime.runPromise(Effect.service(Chat))
  const store = await runtime.runPromise(Effect.service(ChatStore))
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  for (const query of [store.shown, store.queued, store.connectionState, store.historyState]) query.tanstack.startSyncImmediate()
  const questions = await runtime.runPromise(Effect.service(QuestionFaults))
  const shapes = await runtime.runPromise(Effect.service(ShapeSource.Faults))
  const fault = (effect: Effect.Effect<void>) => runtime.runSync(effect)
  const exported = async () => {
    for (const each of runtimes.splice(0).reverse()) await each.dispose()
    return read(api.telemetry)
  }
  return {
    ...chat,
    store,
    api,
    runtime,
    questions,
    shapes,
    fault,
    onApi: <A>(effect: Effect.Effect<A>) => runtime.runPromise(effect),
    exported,
  }
}

// A UUID-shaped answer invokes the agent's product-word correction. This
// marker tests redaction while remaining an ordinary answer the model can give.
const sentinel = () => `sentinel-${crypto.randomUUID().replaceAll("-", "")}`
const shown = (tab: Awaited<ReturnType<typeof open>>) =>
  tab.queries.conversation.toArray.map(({ role, status }) => `${role} ${status}`)

test("asking: asked, stored and not sent, one trace from the ask through the outbox to ChatApi, and the metrics", async () => {
  const tab = await open({ answers: true })
  const secret = sentinel()
  tab.actions.openComposer("button")
  const stored = (await tab.actions.ask(`What is ${secret}?`))
  if (!stored.asked) throw new Error("not asked")
  const reply = await tab.onApi(tab.api.answerTo(`What is ${secret}?`))
  reply.say(`It is ${secret}.`)
  reply.done()
  // The device's agent settles the answer: its engine's run, on a loaded machine, can take a while.
  await until(() => expect(shown(tab)).toEqual(["user done", "assistant done"]), 15_000).catch(async (cause: unknown) => {
    const diagnostics = await tab.onApi(tab.api.answerDiagnostics(stored.answerId))
    throw new Error(`Answer did not settle: ${JSON.stringify(diagnostics)}`, { cause })
  })
  expect(tab.api.modelRequests(`What is ${secret}?`)).toBe(1)
  tab.fault(tab.questions.failNext("bad_request"))
  const refused = (await tab.actions.ask(`And ${secret} again?`))
  if (!refused.asked) throw new Error("not asked")
  await until(() => expect(shown(tab).at(-1)).toBe("user unsent"))
  tab.actions.discardUnsent(refused.questionId)
  const { spans } = tab.api
  const records = await tab.exported()

  const chat = { feature: "chat" }
  const ids = (asked: { questionId: string; answerId: string }) => ({ questionId: asked.questionId, answerId: asked.answerId })
  expect(records.log("question asked")).toEqual([
    expect.objectContaining({
      severity: "Info",
      attributes: { ...chat, ...ids(stored), "question.length": secret.length + 9, queued: false },
    }),
    expect.objectContaining({
      severity: "Info",
      attributes: { ...chat, ...ids(refused), "question.length": secret.length + 11, queued: false },
    }),
  ])
  expect(records.log("question stored")).toEqual([
    expect.objectContaining({ severity: "Info", attributes: { ...chat, ...ids(stored), taken: "inserted" } }),
  ])
  expect(records.log("question not sent")).toEqual([
    expect.objectContaining({ severity: "Warn", attributes: { ...chat, ...ids(refused), reason: "refused", status: 400 } }),
  ])
  expect(records.log("unsent question handled")).toEqual([
    expect.objectContaining({ attributes: { ...chat, questionId: refused.questionId, action: "discard" } }),
  ])

  // The ask's span, then each send's, linked to it; inside, the send and its POST, in ChatApi's trace.
  const [askStored] = records.span("chat.ask")
  expect(askStored?.attributes).toEqual({ ...ids(stored), "question.length": secret.length + 9 })
  const [sent, refusedSend] = records.span("outbox.send")
  expect(sent).toMatchObject({ attributes: { name: "ask", attempt: 1, outcome: "sent" } })
  expect(sent!.links.map(({ spanId }) => spanId)).toEqual([askStored!.spanId])
  expect(refusedSend).toMatchObject({ attributes: { name: "ask", attempt: 1, outcome: "refused" } })
  const [send] = records.span("chat.ask.send")
  expect(send).toMatchObject({
    traceId: sent!.traceId,
    parentSpanId: sent!.spanId,
    attributes: { ...ids(stored), taken: "inserted" },
  })
  const [post] = records.span("chat.question.post")
  expect(post).toMatchObject({ traceId: send!.traceId, parentSpanId: send!.spanId, attributes: { "http.response.status_code": 202 } })
  expect(spans.find(({ name }) => name === "chat.question")?.traceId).toBe(send!.traceId)

  expect(records.point("smithers_web_questions", { queued: "false" })?.value).toBe(2)
  expect(records.point("smithers_web_ask_failures", { reason: "refused" })?.value).toBe(1)
  expect(records.point("smithers_web_unsent_actions", { action: "discard" })?.value).toBe(1)
  expect(records.point("smithers_web_composer_opens", { via: "button" })?.value).toBe(1)
  expect(records.point("smithers_web_answer_first_text_ms")?.count).toBe(1)
  expect(records.point("outbox_attempts", { name: "ask", outcome: "sent" })?.value).toBe(1)
  expect(records.point("outbox_attempts", { name: "ask", outcome: "refused" })?.value).toBe(1)
  expect(records.point("outbox_refused", { name: "ask", status: "400" })?.value).toBe(1)
  expect(records.point("outbox_queued_ms", { name: "ask" })?.count).toBe(1)
  expect(records.point("outbox_leader_changes", { leader: "true" })?.value).toBe(1)
  expect(records.point("persistence_restore_ms", { collection: "chat-messages" })?.count).toBe(1)
  expect(tab.api.telemetry.map(({ body }) => body).join("\n")).not.toContain(secret)
})

test("an answer not started: ChatApi took the question, but this tab has no engine to record its run, so it is sent again", async () => {
  const tab = await open({ host: nodeDevice({ engineWorker: failingWorker }) })
  const asked = (await tab.actions.ask(`What is ${sentinel()}?`))
  if (!asked.asked) throw new Error("not asked")
  const retried = Metric.withAttributes(Outbox.attempts, { name: "ask", outcome: "retry" })
  await until(() => expect(tab.runtime.runSync(Metric.value(retried)).count).toBeGreaterThanOrEqual(1), 10_000)
  const records = await tab.exported()

  expect(records.log("answer not started")).toContainEqual(
    expect.objectContaining({
      severity: "Warn",
      attributes: { feature: "chat", questionId: asked.questionId, answerId: asked.answerId, reason: "unavailable" },
    }),
  )
})

test("the connection and the window: offline, retried and up again, earlier messages shown, and their metrics", async () => {
  const tab = await open({
    pageSize: 2,
    unreachableAfter: "300 millis",
    retry: SyncPolicy.backoff({ initial: "20 millis", max: "50 millis" }),
  })
  const secret = sentinel()
  await tab.onApi(tab.api.askElsewhere(`Earlier ${secret}`))
  await tab.onApi(tab.api.askElsewhere(`Later ${secret}`))
  await until(() => expect(tab.queries.history.toArray[0]?.earlier).toBe(true))
  tab.actions.loadEarlier()
  const chatRequests = () => tab.runtime.runSync(tab.shapes.sent).filter((url) => url.pathname === SHAPE_ROUTE)
  const sentBeforeFault = chatRequests().length
  const observe = (stage: string, assertion: () => void, timeout = 4_000) => until(assertion, timeout).catch((cause: unknown) => {
    const requests = chatRequests()
    const connection = tab.queries.connection.toArray[0]
    throw new Error(`Shape fault observation: ${JSON.stringify({
      stage,
      sentBeforeFault,
      sent: requests.length,
      live: requests.filter((url) => url.searchParams.get("live") === "true").length,
      connection: { status: connection?.status, retry: connection?.retry },
    })}`, { cause })
  })
  // Down applies when the next request starts. The held healthy long poll
  // first delivers this change; replication latency is setup, not time spent
  // failing. Observe the chat shape's next request before its four-second
  // offline deadline, within the same 15-second delivery budget as a chat send.
  tab.fault(tab.shapes.down())
  await tab.onApi(tab.api.askElsewhere(`During ${secret}`))
  await observe("awaiting_fault_request", () => expect(chatRequests().length).toBeGreaterThan(sentBeforeFault), 15_000)
  await observe("fault_applied", () => expect(tab.queries.connection.toArray[0]).toMatchObject({ status: "offline", retry: true }))
  tab.fault(tab.shapes.heal)
  tab.actions.retry()
  await until(() => expect(tab.queries.connection.toArray[0]?.status).toBe("up"))
  const records = await tab.exported()

  const chat = { feature: "chat" }
  expect(records.log("chat connection changed").map(({ attributes }) => attributes)).toEqual([
    { ...chat, status: "offline" },
    { ...chat, status: "up" },
  ])
  expect(records.log("chat retried")).toEqual([
    expect.objectContaining({ severity: "Info", attributes: { ...chat, via: "button" } }),
  ])
  expect(records.point("smithers_web_sync_failures", { reason: "unreachable" })?.value).toBe(1)
  expect(records.point("smithers_web_sync_retries", { via: "button" })?.value).toBe(1)
  expect(records.point("smithers_web_history_loads")?.value).toBe(1)
  expect(tab.api.telemetry.map(({ body }) => body).join("\n")).not.toContain(secret)
})
