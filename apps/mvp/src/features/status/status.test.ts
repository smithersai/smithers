// Agent status on the tab, driven as React drives it: through the status layer's plain actions, reading its live
// queries, with no React. Each device runs the browser's own layer (`appLayer`) on a Node device (src/test/chatApi.ts)
// whose engine leads, against ChatApi's real handler over the compose Postgres and Electric. Only the model is
// scripted. Proves decision 0015's first slice: the agent's question reaches the conversation's status, the header's
// queries, `core/waits`, the toasts and the title on every device, and an answer from any of them resumes the run.
import { Effect, type ManagedRuntime, Metric } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import * as Conversations from "../../../worker/branch/Conversations.ts"
import { shaOf } from "../../../worker/test/branch.ts"
import { Chat } from "../chat/chat"
import { dispatches } from "../../flows/dispatch"
import { nodeDevice, openFaultyTab, openTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { plain } from "../../test/deviceFixture"
import { EngineFaults } from "../../test/faults"
import { renderHeaderStatus } from "./header-render"
import { Status } from "./status"
import { shown, StatusStore } from "./store"

/** A test that drives devices' engines through model calls and sync: seconds each, more on a loaded machine. */
const ENGINE_WITHIN = 90_000

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>, timeout = 60_000) =>
  vi.waitFor(assertion, { timeout, interval: 20 })

/** ChatApi, from a first tab whose engine never leads: the devices below are the ones that answer. */
const openApi = async () => {
  const runtime = openTestApp({ answers: false })
  runtimes.push(runtime)
  return runtime.runPromise(Effect.service(TestChatApi))
}

/**
 * A device whose engine leads, with a tab on it; its title starts as `Smithers` and records every write. A `faulty` tab
 * has its engine behind `EngineFaults`.
 */
const openDevice = async (
  api: TestChatApi["Service"],
  options: { readonly titled?: boolean; readonly faulty?: boolean } = {},
) => {
  const titles: Array<string> = []
  const host = nodeDevice({
    agent: api,
    ...(options.titled === false ? {} : { title: { read: () => "Smithers", write: (title) => void titles.push(title) } }),
  })
  const runtime: ManagedRuntime.ManagedRuntime<Chat | Status | StatusStore, unknown> = options.faulty === true
    ? openFaultyTab(api, { host })
    : openTab(api, { host })
  runtimes.push(runtime)
  const chat = await runtime.runPromise(Effect.service(Chat))
  const status = await runtime.runPromise(Effect.service(Status))
  const store = await runtime.runPromise(Effect.service(StatusStore))
  for (const query of [store.statuses, store.waits, store.latest]) query.tanstack.startSyncImmediate()
  return {
    chat,
    status,
    store,
    titles,
    statusOf: (id: string) => store.statuses.tanstack.toArray.find((row) => row.id === id),
    waits: () => store.waits.tanstack.toArray.map(plain),
    latest: () => store.latest.tanstack.toArray[0],
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>) => runtime.runSync(Metric.value(metric)).count,
    faults: () => runtime.runPromise(Effect.service(EngineFaults) as Effect.Effect<EngineFaults["Service"], never, never>),
  }
}

const ask = (device: Awaited<ReturnType<typeof openDevice>>, text: string) => {
  const asked = device.chat.actions.ask(text)
  if (!asked.asked) throw new Error(`the question was refused: ${asked.reason}`)
  return asked.answerId
}

const askCell = (need: string) => `const heard = await ctx.call("app/agent/ask", ${need})\nconsole.log(JSON.stringify(heard))`

describe("a question from the agent", { timeout: ENGINE_WITHIN }, () => {
  test("shows on every device and in the title; an answer from another device resumes the run, and every view settles", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    const b = await openDevice(api)
    const answerId = ask(a, "Deploy the docs preview")
    const first = await Effect.runPromise(api.answerTo("Deploy the docs preview"))
    // Working first: the answer streams.
    await until(() => expect(a.statusOf(answerId)?.state).toBe("working"))
    expect(a.latest()).toMatchObject({ id: answerId, state: "working" })
    first.cell(askCell(`{ kind: "question", prompt: "Which branch should I deploy?", options: ["main", "docs-v2"] }`))

    for (const device of [a, b]) {
      await until(() => expect(device.statusOf(answerId)?.state).toBe("needs_you"))
      expect(device.statusOf(answerId)).toMatchObject({
        version: 1,
        wait: { kind: "question", prompt: "Which branch should I deploy?", options: ["main", "docs-v2"] },
        answer: null,
        sending: false,
        draft: "",
        focus: 0,
      })
      expect(device.waits()).toEqual([{
        runId: answerId,
        version: 1,
        execution: expect.any(String),
        kind: "question",
        prompt: "Which branch should I deploy?",
        options: ["main", "docs-v2"],
        question: true,
        approval: false,
        createdAt: expect.any(String),
      }])
    }
    await until(() => expect(a.titles.at(-1)).toBe("(1) Smithers"))
    expect(a.count(Metric.withAttributes(shown, { surface: "title" }))).toBe(1)

    // This tab's own rows: a draft and Answer's focus, neither of which another tab or device sees.
    a.status.actions.setDraft(answerId, "docs")
    a.status.actions.focus(answerId)
    a.status.actions.focus(answerId)
    expect(a.statusOf(answerId)).toMatchObject({ draft: "docs", focus: 2 })
    expect(b.statusOf(answerId)).toMatchObject({ draft: "", focus: 0 })
    expect(b.waits()).toEqual([expect.objectContaining({ runId: answerId })])

    // The other device answers. Its engine doesn't hold the run; the device that does delivers it.
    b.status.actions.answer(answerId, "docs-v2")
    expect(b.statusOf(answerId)?.sending).toBe(true)
    const second = await Effect.runPromise(api.answerTo("Deploy the docs preview", 1))
    second.cell(`ctx.done("Deploying docs-v2.")`)

    for (const device of [a, b]) {
      await until(() => expect(device.statusOf(answerId)?.state).toBe("done"))
      expect(device.statusOf(answerId)?.answer).toEqual({ value: "docs-v2" })
      expect(device.waits()).toEqual([])
    }
    await until(() => expect(a.titles.at(-1)).toBe("Smithers"))
    expect(a.latest()).toMatchObject({ id: answerId, state: "done" })
    const delivered = Metric.withAttributes(dispatches, { flow: "run/deliver", door: "sync", outcome: "done" })
    await until(() => expect(a.count(delivered)).toBe(1))
    await until(() => expect(b.statusOf(answerId)?.sending).toBe(false))
  })

  test("asked in a branch's conversation, it shows in that conversation, in the title and on every device", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    const b = await openDevice(api)
    const name = `feature/${crypto.randomUUID()}`
    const tracked = await Effect.runPromise(api.branches.run(Conversations.track("github/octo/hello", name, "open", shaOf(name))))
    const branch = tracked.branch.conversationId
    for (const device of [a, b]) await device.chat.actions.show(branch)
    const inBranch = (device: Awaited<ReturnType<typeof openDevice>>) => {
      const { statuses, latest } = device.status.queries.of(branch)
      statuses.startSyncImmediate()
      latest.startSyncImmediate()
      return { statusOf: (id: string) => statuses.toArray.find((row) => row.id === id), latest: () => latest.toArray[0] }
    }
    const answerId = ask(a, "Deploy the branch preview")
    const first = await Effect.runPromise(api.answerTo("Deploy the branch preview"))
    first.cell(askCell(`{ kind: "question", prompt: "Which region?", options: ["us", "eu"] }`))

    for (const device of [a, b]) {
      await until(() => expect(inBranch(device).statusOf(answerId)?.state).toBe("needs_you"))
      expect(inBranch(device).statusOf(answerId)).toMatchObject({ version: 1, wait: { prompt: "Which region?" } })
      expect(inBranch(device).latest()).toMatchObject({ id: answerId, state: "needs_you" })
      // Home has no such answer; the questions that need the person are every conversation's.
      expect(device.statusOf(answerId)).toBeUndefined()
      await until(() => expect(device.waits()).toEqual([expect.objectContaining({ runId: answerId, version: 1 })]))
    }
    await until(() => expect(a.titles.at(-1)).toBe("(1) Smithers"))
    expect(a.count(Metric.withAttributes(shown, { surface: "title" }))).toBe(1)

    // Answer twice while the first is still sending: one answer goes.
    b.status.actions.answer(answerId, "eu")
    b.status.actions.answer(answerId, "eu")
    const second = await Effect.runPromise(api.answerTo("Deploy the branch preview", 1)).catch(async (cause: unknown) => {
      const diagnostics = await Effect.runPromise(api.answerDiagnostics(answerId)).catch(() => ({ unavailable: true }))
      throw new Error(`Branch answer did not resume: ${JSON.stringify(diagnostics)}`, { cause })
    })
    second.cell(`ctx.done("Deploying to eu.")`)
    for (const device of [a, b]) {
      await until(() => expect(inBranch(device).statusOf(answerId)?.state).toBe("done"))
      expect(inBranch(device).statusOf(answerId)?.answer).toEqual({ value: "eu" })
      expect(device.waits()).toEqual([])
    }
    await until(() => expect(a.titles.at(-1)).toBe("Smithers"))
    const answered = Metric.withAttributes(dispatches, { flow: "run/answer", door: "button", outcome: "done" })
    await until(() => expect(b.count(answered)).toBe(1))
    // A branch chat never opened reads as home, as does a place not read yet.
    expect(a.status.queries.of(crypto.randomUUID()).statuses).toBe(a.status.queries.of(null).statuses)
    expect(a.status.queries.of(undefined).latest).toBe(a.status.queries.of(null).latest)
    // The same conversation's status, read again, is the one built first.
    expect(a.status.queries.of(branch).statuses).toBe(a.status.queries.of(branch).statuses)
  })

  test("an approval answered with a note on the same device resumes the run; nothing acts on a question that isn't open", async () => {
    const api = await openApi()
    const a = await openDevice(api, { titled: false })
    const answerId = ask(a, "Clean up old previews")
    // Nothing is open yet: every action is a no-op.
    a.status.actions.answer(answerId, true)
    a.status.actions.setDraft(answerId, "x")
    a.status.actions.focus(answerId)
    const first = await Effect.runPromise(api.answerTo("Clean up old previews"))
    first.cell(askCell(`{ kind: "approval", prompt: "Delete the stale preview docs-v1?" }`))
    await until(() => expect(a.statusOf(answerId)?.state).toBe("needs_you"))
    expect(a.statusOf(answerId)).toMatchObject({ draft: "", focus: 0, wait: { kind: "approval", options: [] } })
    expect(a.store.local.tanstack.toArray).toEqual([])

    expect(a.waits()).toEqual([expect.objectContaining({ runId: answerId, kind: "approval", options: [], question: false, approval: true })])

    // Approve, with a note.
    a.status.actions.answer(answerId, { approved: true, note: "Only docs-v1." })
    const second = await Effect.runPromise(api.answerTo("Clean up old previews", 1))
    second.cell(`ctx.done("Deleted docs-v1.")`)
    await until(() =>
      expect(a.statusOf(answerId)).toMatchObject({ state: "done", answer: { value: { approved: true, note: "Only docs-v1." } } })
    )
    expect(a.waits()).toEqual([])
  })

  test("an older answer settling late leaves the next question's draft as it is", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    const b = await openDevice(api, { faulty: true })
    const answerId = ask(a, "Pick two regions")
    const first = await Effect.runPromise(api.answerTo("Pick two regions"))
    first.cell(askCell(`{ kind: "question", prompt: "First region?" }`))
    // Both devices show the question before either answers: an answer to a question a device doesn't show yet is
    // nothing, and each device hears of it through its own sync.
    await until(() => expect(b.statusOf(answerId)?.state).toBe("needs_you"))
    await until(() => expect(a.statusOf(answerId)?.state).toBe("needs_you"))
    // B answers the first question, but its engine hasn't taken the answer yet; A answers it meanwhile.
    await Effect.runPromise((await b.faults()).holdStarts)
    b.status.actions.answer(answerId, "us")
    a.status.actions.answer(answerId, "eu")
    const second = await Effect.runPromise(api.answerTo("Pick two regions", 1))
    second.cell(askCell(`{ kind: "question", prompt: "Second region?" }`))
    await until(() => expect(b.statusOf(answerId)).toMatchObject({ state: "needs_you", version: 2 }))
    b.status.actions.setDraft(answerId, "ap")
    // B's answer to the first question now goes, and is refused: that question closed.
    await Effect.runPromise((await b.faults()).releaseStarts)
    const closed = Metric.withAttributes(dispatches, { flow: "run/answer", door: "button", outcome: "failed" })
    await until(() => expect(b.count(closed)).toBe(1))
    expect(b.statusOf(answerId)).toMatchObject({ version: 2, draft: "ap", sending: false })
  })

  test("a second question waits its turn behind one that needs the person, and the latest answer says so", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    const first = ask(a, "First, deploy")
    const reply = await Effect.runPromise(api.answerTo("First, deploy"))
    reply.cell(askCell(`{ kind: "question", prompt: "Which branch?" }`))
    await until(() => expect(a.statusOf(first)?.state).toBe("needs_you"))
    const second = ask(a, "Then bump the version")
    await until(() => expect(a.statusOf(second)?.state).toBe("waiting"))
    expect(a.latest()).toMatchObject({ id: second, state: "waiting" })
    expect(a.waits().map((wait) => wait.runId)).toEqual([first])

    a.status.actions.answer(first, "main")
    ;(await Effect.runPromise(api.answerTo("First, deploy", 1))).cell(`ctx.done("Deployed main.")`)
    ;(await Effect.runPromise(api.answerTo("Then bump the version"))).cell(`ctx.done("Bumped.")`)
    await until(() => expect(a.latest()).toMatchObject({ id: second, state: "done" }))
    expect(a.statusOf(first)?.state).toBe("done")
  })

  test("a failed answer is failed, whatever its run's row says", async () => {
    const api = await openApi()
    const a = await openDevice(api)
    const answerId = ask(a, "Fail, please")
    ;(await Effect.runPromise(api.answerTo("Fail, please"))).fail()
    await until(() => expect(a.statusOf(answerId)?.state).toBe("failed"))
    expect(a.latest()).toMatchObject({ id: answerId, state: "failed" })
    const header = await renderHeaderStatus(a.chat, a.status)
    expect(header).toContain(`href="/app/runs/${answerId}"`)
    expect(header).toContain("Answer failed — view run")
  })
})
