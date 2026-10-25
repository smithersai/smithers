import { questionIn } from "./messages"
import type { Page, Request } from "@playwright/test"
import { faultyApp, faults } from "./faults"
import { answerTo, expect, NOT_SENT, test } from "./fixtures"
import { field, type LogRecord, LogTail, traceIdOf } from "./logs"
import { requires } from "./target"

// docs/observability.md, end to end: a real ask through the real browser, ChatApi, Postgres, Electric and model, read
// back from the records ChatApi writes. Locally `alchemy dev` writes each Worker's log under
// `.alchemy/log/dev_<user>/<Worker>/`, and ChatApi's log also holds the browser's OTLP records it relayed
// (`otlp.signal`). A deployment uses a Cloudflare tail whose readiness trace must arrive before the ask; a sampling
// warning or disconnected tail fails capture explicitly, preserving every record and trace assertion below.
// Both ask, a Member's (worker/Chat.ts `canAsk`).

requires("localLogs", "member")

const openChat = async (page: Page, path = "/app") => {
  await page.goto(path)
  await expect(page.getByRole("button", { name: /Chat/ })).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press("ControlOrMeta+k")
  return {
    composer: page.getByRole("textbox", { name: "Message Smithers" }),
    conversation: page.getByRole("region", { name: "Conversation", exact: true }),
  }
}

const isQuestions = (request: Request) => new URL(request.url()).pathname === "/api/questions"

test("correlation: the browser's ask, its agent's dispatch and ChatApi's chat.question and chat.answer.write records share the answer id; the ask shares one trace", { annotation: { type: "summary", description: "One ask's records, in the browser and on the server, share its answer id and one trace." } }, async ({ page }) => {
  const logs = await LogTail.start({ postOnly: true, isolated: true })
  try {
    await page.context().setExtraHTTPHeaders(logs.captureHeaders)
    const { composer, conversation } = await openChat(page)
    const word = `trace-${Date.now()}`
    const question = `Reply with exactly the word: ${word}`
    const posted = page.waitForRequest(isQuestions)
    await composer.fill(question)
    await composer.press("Enter")

    // The browser's ask: W3C trace context on POST /api/questions, and the answer id in its body.
    const request = await posted
    const traceparent = request.headers()["traceparent"] ?? ""
    expect(traceparent, "POST /api/questions sends traceparent").toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
    const traceId = traceparent.split("-")[1]
    const { id: questionId, answerId } = request.postDataJSON() as { id: string; answerId: string }
    await expect(answerTo(conversation, question)).toContainText(word, { timeout: 60_000 })

    // ChatApi logs chat.question for this ask and chat.answer.write when the browser's agent settles the answer, and
    // relays the browser's `question stored` log, its `chat.ask.send` span and the `flow.dispatch` that started the agent
    // (`chat/Answer`, executed under the answer's id), all carrying the answer id.
    let records = await logs.records()
    const find = (from: Array<LogRecord>, message: string, check: (record: LogRecord) => boolean = () => true) =>
      from.find((record) => record.message === message && field(record, "answerId") === answerId && check(record))
    const dispatched = (from: Array<LogRecord>) =>
      from.find((record) => record.message === "flow.dispatch" && field(record, "executionId") === answerId)
    const settled = (record: LogRecord) => field(record, "write") === "done"
    await expect
      .poll(
        async () => {
          records = await logs.records()
          return {
            "chat.question": find(records.own, "chat.question") !== undefined,
            "chat.answer.write": find(records.own, "chat.answer.write", settled) !== undefined,
            "question stored": find(records.browser, "question stored") !== undefined,
            "chat.ask.send": find(records.browser, "chat.ask.send") !== undefined,
            "flow.dispatch": dispatched(records.browser) !== undefined,
          }
        },
        { timeout: 30_000, message: "ChatApi's log has every record of this ask" },
      )
      .toEqual({ "chat.question": true, "chat.answer.write": true, "question stored": true, "chat.ask.send": true, "flow.dispatch": true })
    const chatQuestion = find(records.own, "chat.question")!
    expect(field(chatQuestion, "questionId")).toBe(questionId)
    expect(field(chatQuestion, "status")).toBe(202)
    expect(field(find(records.own, "chat.answer.write", settled)!, "status")).toBe(200)
    const dispatch = dispatched(records.browser)!
    expect(field(dispatch, "flow")).toBe("chat/Answer")
    expect(field(dispatch, "door")).toBe("composer")

    // One trace for the ask: the browser's records and ChatApi's carry the trace id the browser sent. The agent's run is
    // its own trace.
    expect.soft(traceIdOf(find(records.browser, "question stored")), "the browser's `question stored` log is in the send's trace").toBe(traceId)
    expect.soft(traceIdOf(find(records.browser, "chat.ask.send")), "the browser's `chat.ask.send` span is in the send's trace").toBe(traceId)
    expect.soft(traceIdOf(chatQuestion), "ChatApi's chat.question record carries the ask's trace id").toBe(traceId)
  } finally {
    await logs.dispose()
  }
})

test("redaction: a sentinel word in questions never appears in ChatApi's log or the browser's relayed records", { annotation: { type: "summary", description: "A word from a question never appears in the server's log or the browser's relayed records." } }, async ({ page }) => {
  requires("faults")
  const logs = await LogTail.start({ postOnly: true, isolated: true })
  try {
    await page.context().setExtraHTTPHeaders(logs.captureHeaders)
    // The app on its faulty services (e2e/faults.ts): the real ones until the lost question below.
    const { composer, conversation } = await openChat(page, faultyApp())
    const sentinel = `sentinel${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

    // An answered question: the sentinel is in the question and in the answer.
    const answered = `Reply with exactly the word: ${sentinel}`
    const posted = page.waitForRequest(isQuestions)
    await composer.fill(answered)
    await composer.press("Enter")
    const { answerId } = (await posted).postDataJSON() as { answerId: string }
    await expect(answerTo(conversation, answered)).toContainText(sentinel, { timeout: 60_000 })

    // A question ChatApi refused (400): it stays on the device, Not sent, and the browser logs `question not sent`. The
    // fault keeps it off the network, so its answer id comes from the questions the app's client was given.
    await faults(page).questions.failNext("bad_request")
    const lost = `Never delivered ${sentinel}`
    await composer.fill(lost)
    await composer.press("Enter")
    await expect(questionIn(conversation, lost).getByText(NOT_SENT, { exact: true })).toBeVisible({ timeout: 30_000 })
    const lostQuestion = (await faults(page).questions.asked()).find(({ text }) => text === lost)
    expect(lostQuestion, "the app asked its client the lost question").toBeDefined()
    const lostAnswerId = lostQuestion!.answerId

    // Wait until every record of both asks is in the log, so the scan below covers them.
    await expect
      .poll(
        async () => {
          const { own, browser } = await logs.records()
          const has = (from: Array<LogRecord>, message: string, id: string) => from.some((record) => record.message === message && field(record, "answerId") === id)
          return {
            "chat.question": has(own, "chat.question", answerId),
            "chat.answer.write": has(own, "chat.answer.write", answerId),
            "question asked": has(browser, "question asked", answerId),
            "question stored": has(browser, "question stored", answerId),
            "question not sent": has(browser, "question not sent", lostAnswerId),
          }
        },
        { timeout: 30_000, message: "ChatApi's log has every record of both asks" },
      )
      .toEqual({ "chat.question": true, "chat.answer.write": true, "question asked": true, "question stored": true, "question not sent": true })

    const lines = await logs.lines()
    expect(lines.length).toBeGreaterThan(0)
    const leaks = lines.filter((line) => line.text.includes(sentinel)).map((line) => `${line.worker}: ${line.text.slice(0, 300)}`)
    expect(leaks, "no log line, of any Worker, carries what someone wrote or the answer").toEqual([])
  } finally {
    await logs.dispose()
  }
})
