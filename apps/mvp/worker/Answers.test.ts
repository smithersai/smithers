// The answer routes (worker/Answers.ts, docs/features/agent.md#the-answer-routes), through ChatApi's real handler on
// this file's schema of the compose Postgres (`pnpm db:up`). No model runs here: the browser's agent is what calls
// these routes, and src/features/agent/agent.test.ts runs it against them.
import { Effect, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import { AGENT_LIVE_SECONDS } from "../src/features/model/contract.ts"
import { answerRow } from "../src/test/agent.ts"
import type { Actor } from "./Actor.ts"
import * as Answers from "./Answers.ts"
import { shared, tracked } from "./test/branch.ts"
import { harness, recorded, row, testFile } from "./test/harness.ts"

const runtime = testFile("answers")

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

const open = (options: { readonly actor?: Actor | null; readonly config?: Record<string, string> } = {}) =>
  harness(runtime, () => Stream.empty, {
    ...(options.actor === null ? {} : { actor: options.actor ?? member }),
    ...(options.config === undefined ? {} : { config: options.config }),
  })

type Harness = Awaited<ReturnType<typeof open>>

/** Asks `text`; resolves with the answer's id. */
const ask = async (h: Harness, text: string) => {
  const question = { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text }
  expect((await h.ask(question)).status).toBe(202)
  return question.answerId
}

/** Settles an answer as the agent would, through the route. */
const write = (h: Harness, answerId: string, body: unknown) =>
  h.fetch(`/api/answers/${answerId}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })

const turn = (h: Harness, answerId: string) => h.fetch(`/api/answers/${answerId}`)

/** Dates an answer's last write `seconds` ago, as if its device had gone quiet that long. */
const quiet = (answerId: string, seconds: number) =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`UPDATE messages SET updated_at = now() - make_interval(secs => ${seconds}) WHERE id = ${answerId}`,
    ),
  )

/** Dates when an answer was asked `seconds` ago, as for a question that waited in a long queue. */
const askedAgo = (answerId: string, seconds: number) =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`UPDATE messages SET created_at = now() - make_interval(secs => ${seconds}) WHERE id = ${answerId}`,
    ),
  )

/** A `not_your_turn` refusal, with how long the turn has waited. */
const notYourTurn = { code: "not_your_turn", waitedMs: expect.any(Number) }

/** When an answer was last written, in epoch milliseconds. */
const writtenAt = (answerId: string) =>
  runtime.runPromise(
    Effect.map(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly at: Date }>`SELECT updated_at AS at FROM messages WHERE id = ${answerId}`,
      ),
      ([found]) => found!.at.getTime(),
    ),
  )

const step = (id: string, status: "running" | "done" | "failed" = "done") => ({
  id,
  kind: "step",
  flow: "app/theme/set",
  status,
})

describe("GET /api/answers/<id>: the turn", () => {
  test("answers the question and the finished exchanges before it, oldest first", async () => {
    const h = await open()
    const first = await ask(h, "What is Smithers?")
    expect((await write(h, first, { status: "done", text: "A coding factory.", parts: [] })).status).toBe(200)
    const second = await ask(h, "And who makes it?")

    const response = await turn(h, second)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      question: "And who makes it?",
      history: [{ question: "What is Smithers?", answer: "A coding factory." }],
    })
    expect(h.only("chat.answer.turn").annotations).toMatchObject({ answerId: second, status: 200, historyExchanges: 1 })
  })

  test("waits its turn while an earlier answer streams, and refuses an answer that has settled", async () => {
    const h = await open()
    const first = await ask(h, "One")
    const second = await ask(h, "Two")

    const waiting = await turn(h, second)
    await write(h, first, { status: "failed", failure: "model_error" })
    const after = await turn(h, second)
    const settled = await turn(h, first)

    expect([waiting.status, await waiting.json()]).toEqual([409, notYourTurn])
    expect(after.status).toBe(200)
    expect([settled.status, await settled.json()]).toEqual([409, { code: "settled" }])
  })

  test("an earlier answer whose device went quiet past the bound is fenced before a later turn starts", async () => {
    const h = await open()
    const orphan = await ask(h, "One")
    const quietJustUnder = await ask(h, "Two")
    const next = await ask(h, "Three")

    await quiet(orphan, AGENT_LIVE_SECONDS + 1)
    await quiet(quietJustUnder, AGENT_LIVE_SECONDS - 5)
    const held = await turn(h, next)
    await quiet(quietJustUnder, AGENT_LIVE_SECONDS + 1)
    const free = await turn(h, next)

    // Two's last write was within the bound, so it still held Three; then it was past it, and nothing held Three.
    expect([held.status, await held.json()]).toEqual([409, notYourTurn])
    expect(free.status).toBe(200)
    // A frozen old host cannot resume writing after another answer was admitted.
    expect(await row(runtime, orphan)).toMatchObject({ status: "failed", failure: "abandoned", text: "" })
    expect(await row(runtime, quietJustUnder)).toMatchObject({ status: "failed", failure: "abandoned", text: "" })
    expect((await write(h, orphan, { status: "done", text: "Late" })).status).toBe(409)
    expect((await h.fetch(`/api/answers/${orphan}`, { method: "PATCH" })).status).toBe(204)
  })

  test.each(["done", "failed"] as const)("a heartbeat after %s completes without a transport error or renewed lease", async (status) => {
    const h = await open()
    const id = await ask(h, "A quick answer")
    await write(h, id, status === "done" ? { status, text: "Hello" } : { status, failure: "model_error" })
    const before = await writtenAt(id)
    const heartbeat = await h.fetch(`/api/answers/${id}`, { method: "PATCH" })
    expect(heartbeat.status).toBe(204)
    expect(await heartbeat.text()).toBe("")
    expect(await writtenAt(id)).toBe(before)
    expect(await answerRow(runtime, id)).toMatchObject({ status })
    expect(h.only("chat.answer.heartbeat").annotations).toMatchObject({ status: 204, renewed: false })
  })

  test("confirmed host heartbeats keep a silent answer ahead of later turns without exposing text", async () => {
    const h = await open()
    const first = await ask(h, "First")
    const second = await ask(h, "Second")
    await quiet(first, AGENT_LIVE_SECONDS + 1)
    const heartbeat = await h.fetch(`/api/answers/${first}`, { method: "PATCH" })
    expect(heartbeat.status).toBe(200)
    expect(await answerRow(runtime, first)).toMatchObject({ status: "streaming", text: "", parts: [] })
    expect((await turn(h, second)).status).toBe(409)
    expect(h.only("chat.answer.heartbeat").annotations).toMatchObject({ answerId: first, status: 200, renewed: true })
    expect(h.count(Answers.requests, { route: "heartbeat", status: "200" })).toBe(1)
    await write(h, first, { status: "done", text: "First answer." })
    const next = await turn(h, second)
    expect(await next.json()).toMatchObject({ history: [{ question: "First", answer: "First answer." }] })
  })

  test("heartbeat authority matches answer writes and cannot touch another person's answer", async () => {
    const h = await open()
    const other = await open({ actor: { subject: { kind: "person", id: "other" }, role: "member" } })
    const signedOut = await open({ actor: null })
    // An Admin passes branch access but still cannot renew another person's answer.
    const admin = await open({ actor: { subject: { kind: "person", id: "heartbeat-admin" }, role: "admin" } })
    const id = await ask(h, "Private")
    await quiet(id, AGENT_LIVE_SECONDS + 1)
    const before = await writtenAt(id)
    expect((await other.fetch(`/api/answers/${id}`, { method: "PATCH" })).status).toBe(403)
    expect((await signedOut.fetch(`/api/answers/${id}`, { method: "PATCH" })).status).toBe(401)
    expect((await admin.fetch(`/api/answers/${id}`, { method: "PATCH" })).status).toBe(403)
    expect(admin.only("chat.answer.heartbeat").annotations).toMatchObject({ status: 403, errorCode: "not_asker" })
    expect(await writtenAt(id)).toBe(before)
    const absent = await h.fetch(`/api/answers/${crypto.randomUUID()}`, { method: "PATCH" })
    expect(absent.status).toBe(404)
    expect(await absent.json()).toEqual({ code: "not_found" })
  })

  test("a later question leaves a durable open question answerable after its host lease", async () => {
    const h = await open()
    const first = await ask(h, "Please ask me")
    const report = await h.fetch(`/api/runs/${first}`, { method: "POST", body: JSON.stringify({
      status: "needs_you", wait: { execution: `${first}/call/0.0`, kind: "question", prompt: "Which one?", options: [] },
    }) })
    expect(report.status).toBe(200)
    await quiet(first, AGENT_LIVE_SECONDS + 1)
    const second = await ask(h, "Another question")
    expect((await turn(h, second)).status).toBe(409)
    expect(await row(runtime, first)).toMatchObject({ status: "streaming" })
    expect((await h.fetch(`/api/runs/${first}/answer`, { method: "POST", body: JSON.stringify({ version: 1, value: "This one" }) })).status).toBe(200)
    expect((await h.fetch(`/api/runs/${first}`, { method: "POST", body: JSON.stringify({ status: "working" }) })).status).toBe(200)
    // A fresh status transition gives the resumed interpreter its first pulse's
    // grace, even before its answer timestamp has been renewed.
    const third = await ask(h, "One more")
    await quiet(second, AGENT_LIVE_SECONDS + 1)
    expect((await turn(h, third)).status).toBe(409)
    expect((await write(h, first, { status: "done", text: "Answered your choice." })).status).toBe(200)
  })

  test("a stalled write body holds no conversation lock while the host renews its lease", async () => {
    const h = await open()
    const id = await ask(h, "Quiet")
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let read!: () => void
    const reading = new Promise<void>((resolve) => { read = resolve })
    const body = new ReadableStream<Uint8Array>({
      start: (stream) => { controller = stream },
      pull: () => { read() },
    }, { highWaterMark: 0 })
    const pending = h.fetch(`/api/answers/${id}`, { method: "POST", body, duplex: "half" } as RequestInit)
    await reading
    try {
      const renewed = await Effect.runPromise(
        Effect.tryPromise(() => h.fetch(`/api/answers/${id}`, { method: "PATCH" })).pipe(
          Effect.timeout("5 seconds"),
        ),
      )
      expect(renewed.status).toBe(200)
    } finally {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ status: "streaming", parts: [] })))
      controller.close()
    }
    expect((await pending).status).toBe(200)
  })

  test("an answer waiting its turn stays live, so it keeps the answers after it in order", async () => {
    const h = await open()
    const first = await ask(h, "One")
    const second = await ask(h, "Two")
    const third = await ask(h, "Three")
    await quiet(second, AGENT_LIVE_SECONDS * 2)
    const before = await writtenAt(second)

    const waiting = await turn(h, second)
    await quiet(first, AGENT_LIVE_SECONDS + 1)
    const behind = await turn(h, third)
    const now = await turn(h, second)

    expect(waiting.status).toBe(409)
    expect(await writtenAt(second)).toBeGreaterThan(before)
    expect([behind.status, await behind.json()]).toEqual([409, notYourTurn])
    expect(now.status).toBe(200)
  })

  test("a waiting answer's turn requests mark it live at most once a third of the bound, so its row isn't rewritten on every poll", async () => {
    const h = await open()
    await ask(h, "One")
    const second = await ask(h, "Two")
    // Written within the last third of the bound: live enough, so a turn request writes nothing.
    await quiet(second, AGENT_LIVE_SECONDS / 3 - 2)
    const fresh = await writtenAt(second)

    expect((await turn(h, second)).status).toBe(409)
    expect((await turn(h, second)).status).toBe(409)
    expect(await writtenAt(second)).toBe(fresh)

    // Older than that: the next request marks it live, once.
    await quiet(second, AGENT_LIVE_SECONDS / 3 + 1)
    const stale = await writtenAt(second)
    expect((await turn(h, second)).status).toBe(409)
    const touched = await writtenAt(second)
    expect((await turn(h, second)).status).toBe(409)

    expect(touched).toBeGreaterThan(stale)
    expect(await writtenAt(second)).toBe(touched)
  })

  test("a waiting answer's refusal says how long its turn has waited: since an earlier answer last settled, or since it was asked", async () => {
    const h = await open()
    const zero = await ask(h, "Zero")
    await write(h, zero, { status: "done", text: "Yes.", parts: [] })
    await ask(h, "One")
    const two = await ask(h, "Two")
    // Two was asked twenty minutes ago, behind a queue; Zero, the latest earlier answer to settle, settled 5 s ago.
    await askedAgo(two, 20 * 60)
    await quiet(zero, 5)
    const sinceSettled = await turn(h, two)
    // Zero settled thirty minutes ago, before Two was asked: Two has waited since it was asked.
    await quiet(zero, 30 * 60)
    const sinceAsked = await turn(h, two)

    const waited = async (response: Response) => {
      const body = (await response.json()) as { readonly code: string; readonly waitedMs: number }
      expect([response.status, body.code]).toEqual([409, "not_your_turn"])
      return body.waitedMs
    }
    const settledWait = await waited(sinceSettled)
    const askedWait = await waited(sinceAsked)
    expect(settledWait).toBeGreaterThanOrEqual(5_000)
    expect(settledWait).toBeLessThan(60_000)
    expect(askedWait).toBeGreaterThanOrEqual(20 * 60_000)
    expect(askedWait).toBeLessThan(21 * 60_000)
    expect(Number.isInteger(askedWait)).toBe(true)
    // Each refusal's log line carries the waited time, so a tail that ran out can be told from a queue that stopped.
    expect(h.line("chat.answer.turn").map((line) => line.annotations.waitedMs)).toEqual([settledWait, askedWait])
  })

  test("ANSWER_TURN_LIVE_SECONDS sets the bound: 30 seconds unless set, and an integer of at least five seconds", async () => {
    const short = await open({ config: { ANSWER_TURN_LIVE_SECONDS: "10" } })
    const usual = await open()
    const first = await ask(short, "One")
    const second = await ask(short, "Two")
    await quiet(first, 11)

    expect((await turn(usual, second)).status).toBe(409)
    expect((await turn(short, second)).status).toBe(200)
    expect(AGENT_LIVE_SECONDS).toBe(30)
    await expect(open({ config: { ANSWER_TURN_LIVE_SECONDS: "0" } })).rejects.toThrow()
    await expect(open({ config: { ANSWER_TURN_LIVE_SECONDS: "4" } })).rejects.toThrow()
  })

  test("refuses a signed-out caller, an id that isn't an answer, and a method it doesn't serve", async () => {
    const signedOut = await open({ actor: null })
    const h = await open()
    const answerId = await ask(h, "Hello")

    expect((await turn(signedOut, answerId)).status).toBe(401)
    expect((await turn(h, "not-a-uuid")).status).toBe(404)
    expect((await turn(h, crypto.randomUUID())).status).toBe(404)
    const put = await h.fetch(`/api/answers/${answerId}`, { method: "PUT", body: "{}" })
    expect([put.status, put.headers.get("allow")]).toEqual([405, "GET, POST, PATCH"])
  })
})

describe("POST /api/answers/<id>: the answer", () => {
  test("writes text and parts while it streams, then settles with its text, parts and tokens", async () => {
    const h = await open()
    const answerId = await ask(h, "Dark mode")

    const streaming = await write(h, answerId, { status: "streaming", parts: [step("0.0", "running")], text: "Dark" })
    const partsOnly = await write(h, answerId, { status: "streaming", parts: [step("0.0")] })
    const midway = await answerRow(runtime, answerId)
    const done = await write(h, answerId, {
      status: "done",
      text: "Dark mode is on.",
      parts: [step("0.0")],
      inputTokens: 40,
      outputTokens: 7,
    })

    expect(streaming.status).toBe(200)
    expect(((await streaming.json()) as { readonly txid: unknown }).txid).toEqual(expect.any(Number))
    expect(partsOnly.status).toBe(200)
    expect(midway).toMatchObject({ status: "streaming", text: "Dark", parts: [step("0.0")] })
    expect(done.status).toBe(200)
    expect(await answerRow(runtime, answerId)).toMatchObject({
      status: "done",
      text: "Dark mode is on.",
      parts: [step("0.0")],
      inputTokens: 40,
      outputTokens: 7,
    })
  })

  test("a settle sent again after it landed is answered as landed; any other write to a settled answer is refused", async () => {
    const h = await open()
    const done = await ask(h, "One")
    const failed = await ask(h, "Two")
    await write(h, done, { status: "done", text: "Yes.", parts: [step("0.0")] })
    await write(h, failed, { status: "failed", failure: "unfinished", parts: [step("0.0", "failed")] })

    const again = await write(h, done, { status: "done", text: "Yes." })
    const other = await write(h, done, { status: "done", text: "No." })
    const streaming = await write(h, done, { status: "streaming", parts: [] })
    const failedAgain = await write(h, failed, { status: "failed", failure: "unfinished" })
    const failedOther = await write(h, failed, { status: "failed", failure: "model_error" })
    const doneOverFailed = await write(h, failed, { status: "done", text: "Late." })

    expect([again.status, await again.json()]).toEqual([200, { txid: null }])
    expect([other.status, await other.json()]).toEqual([409, { code: "settled" }])
    expect(streaming.status).toBe(409)
    expect(failedAgain.status).toBe(200)
    expect(failedOther.status).toBe(409)
    expect(doneOverFailed.status).toBe(409)
    // A settle without parts kept the parts the answer had.
    expect(await answerRow(runtime, done)).toMatchObject({ status: "done", text: "Yes.", parts: [step("0.0")] })
    expect(await answerRow(runtime, failed)).toMatchObject({
      status: "failed",
      failure: "unfinished",
      parts: [step("0.0", "failed")],
    })
  })

  test("refuses a body that isn't an answer write, one that is too large, and an answer that doesn't exist", async () => {
    const h = await open()
    const answerId = await ask(h, "Hello")
    const huge = JSON.stringify({ status: "done", text: "x".repeat(300 * 1024) })

    expect((await write(h, answerId, "not json")).status).toBe(400)
    const brokenUtf8 = await h.fetch(`/api/answers/${answerId}`, {
      method: "POST",
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    })
    expect(brokenUtf8.status).toBe(400)
    expect((await write(h, answerId, { status: "done", text: "" })).status).toBe(400)
    expect((await write(h, answerId, { status: "failed", failure: "abandoned" })).status).toBe(400)
    expect((await write(h, answerId, huge)).status).toBe(413)
    expect((await write(h, crypto.randomUUID(), { status: "done", text: "Hi." })).status).toBe(404)
    const signedOut = await open({ actor: null })
    expect((await write(signedOut, answerId, { status: "done", text: "Hi." })).status).toBe(401)
    expect((await answerRow(runtime, answerId)).status).toBe("streaming")
  })

  test("a question's id is not an answer's", async () => {
    const h = await open()
    const question = { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Hi" }
    await h.ask(question)

    expect((await write(h, question.id, { status: "done", text: "Hi." })).status).toBe(404)
  })
})

describe("who may write", () => {
  test.each([
    ["a Guest", "guest" as const],
    ["a person with no role", null],
  ])("%s is refused 403 forbidden on both routes, and the answer is unchanged", async (_, role) => {
    const h = await open()
    const answerId = await ask(h, "Hello")
    const refused = await open({ actor: { subject: { kind: "person", id: "person-other" }, role } })

    const read = await turn(refused, answerId)
    const written = await write(refused, answerId, { status: "done", text: "Hi." })

    expect([read.status, await read.json()]).toEqual([403, { code: "forbidden" }])
    expect([written.status, await written.json()]).toEqual([403, { code: "forbidden" }])
    expect(await answerRow(runtime, answerId)).toMatchObject({ status: "streaming", text: "" })
    expect(refused.count(Answers.requests, { route: "write", status: "403" })).toBe(1)
  })

  test.each([
    ["another Member", { subject: { kind: "person", id: "person-other-member" }, role: "member" } as Actor],
    ["an Admin who didn't ask", { subject: { kind: "person", id: "person-admin" }, role: "admin" } as Actor],
  ])("%s is refused 403 forbidden on both routes, and the asker's own settle still lands", async (_, other) => {
    const asker = await open()
    const answerId = await ask(asker, "Hello")
    const forger = await open({ actor: other })

    const read = await turn(forger, answerId)
    const streamed = await write(forger, answerId, { status: "streaming", parts: [], text: "forged" })
    const forged = await write(forger, answerId, { status: "done", text: "forged by B" })
    const untouched = await answerRow(runtime, answerId)
    const settled = await write(asker, answerId, { status: "done", text: "Hi." })
    const afterSettle = await write(forger, answerId, { status: "done", text: "Hi." })

    expect([read.status, await read.json()]).toEqual([403, { code: "forbidden" }])
    expect([streamed.status, await streamed.json()]).toEqual([403, { code: "forbidden" }])
    expect([forged.status, await forged.json()]).toEqual([403, { code: "forbidden" }])
    expect(untouched).toMatchObject({ status: "streaming", text: "" })
    expect(settled.status).toBe(200)
    // Even a write that matches what landed is refused: whether the answer landed is the asker's to learn.
    expect([afterSettle.status, await afterSettle.json()]).toEqual([403, { code: "forbidden" }])
    expect(await answerRow(runtime, answerId)).toMatchObject({ status: "done", text: "Hi." })
    expect(forger.only("chat.answer.turn").annotations).toMatchObject({ status: 403, errorCode: "not_asker" })
  })

  test("an asker whose access to the branch was taken away can neither read the turn nor write the answer", async () => {
    const h = await open()
    const branch = await tracked(runtime, "github/octocat/spoon-knife", `answers-${crypto.randomUUID().slice(0, 8)}`, "open", "person-owner")
    await shared(runtime, branch.branchId, member.subject.id, "edit")
    const question = { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Hi", conversationId: branch.conversationId }
    expect((await h.ask(question)).status).toBe(202)
    expect((await turn(h, question.answerId)).status).toBe(200)
    await shared(runtime, branch.branchId, member.subject.id, "view")
    const read = await turn(h, question.answerId)
    const written = await write(h, question.answerId, { status: "done", text: "Hi." })
    expect([read.status, await read.json()]).toEqual([403, { code: "forbidden" }])
    expect([written.status, await written.json()]).toEqual([403, { code: "forbidden" }])
    expect(h.line("chat.answer.write").at(-1)!.annotations).toMatchObject({ status: 403, errorCode: "view_only" })
    expect(await answerRow(runtime, question.answerId)).toMatchObject({ status: "streaming", text: "" })
  })

  test("another Member's turn requests never mark a waiting answer live", async () => {
    const asker = await open()
    await ask(asker, "One")
    const second = await ask(asker, "Two")
    await quiet(second, AGENT_LIVE_SECONDS * 2)
    const before = await writtenAt(second)
    const forger = await open({ actor: { subject: { kind: "person", id: "person-other-member" }, role: "member" } })

    expect((await turn(forger, second)).status).toBe(403)
    expect(await writtenAt(second)).toBe(before)
  })

  test("an agent acting for the asker writes as the asker, and only the answer its run is", async () => {
    const asker = await open()
    const answerId = await ask(asker, "Hello")
    const other = await ask(asker, "Hello again")
    const agent = await open({ actor: { ...member, act: { kind: "agent", id: `${answerId}/call/0.1`, root: answerId } } })

    expect((await turn(agent, answerId)).status).toBe(200)
    expect((await write(agent, answerId, { status: "done", text: "Hi." })).status).toBe(200)
    // The asker's other answer isn't this run's.
    expect((await write(agent, other, { status: "done", text: "Hi." })).status).toBe(403)
  })

  test("an answer whose question records no asker is refused to everyone", async () => {
    const h = await open()
    const answerId = await ask(h, "Hello")
    await runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`UPDATE messages SET asked_by = NULL WHERE id = (SELECT question_id FROM messages WHERE id = ${answerId})`,
      ),
    )

    expect((await turn(h, answerId)).status).toBe(403)
    expect((await write(h, answerId, { status: "done", text: "Hi." })).status).toBe(403)
  })
})

describe("failures and records", () => {
  test("Postgres unreachable answers 503, logged by its SQL reason", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://nobody:nothing@127.0.0.1:1/none")))
    const h = await harness(runtime, () => Stream.empty, { actor: member, database: unreachable })

    const response = await turn(h, crypto.randomUUID())

    expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
    expect(h.only("chat.answer.turn")).toMatchObject({ level: "ERROR", annotations: { status: 503 } })
    expect(String(h.only("chat.answer.turn").annotations.errorCode)).toMatch(/^sql:/)
  })

  test("every request is counted by route and status, and no record carries the answer's text", async () => {
    const h = await open()
    const answerId = await ask(h, "Hello")
    const sentinel = `sentinel-${crypto.randomUUID()}`

    await turn(h, answerId)
    await write(h, answerId, { status: "done", text: sentinel })

    expect(h.count(Answers.requests, { route: "turn", status: "200" })).toBe(1)
    expect(h.count(Answers.requests, { route: "write", status: "200" })).toBe(1)
    expect(h.only("chat.answer.write").annotations).toMatchObject({ answerId, status: 200, write: "done", parts: -1 })
    expect(recorded(h)).not.toContain(sentinel)
    const rows = await runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly text: string }>`SELECT text FROM messages WHERE id = ${answerId}`,
      ),
    )
    expect(rows[0]!.text).toBe(sentinel)
  })
})
