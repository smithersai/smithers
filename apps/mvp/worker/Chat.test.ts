import * as WriteAdmission from "./WriteAdmission.ts"
// ChatApi's routes (worker/Chat.ts) as the browser calls them, against the compose Postgres in this file's own schema
// (worker/test/harness.ts). ChatApi stores questions and never answers them: the browser's agent does
// (src/features/agent/agent.test.ts). The contract is docs/features/chat.md; the records, docs/observability.md.
import { Metric as OtlpMetric } from "@smthrs/observability"
import { Data, Deferred, Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import { type Actor, Sessions, SessionsUnavailable } from "./Actor.vibe"
import * as ConversationPeople from "./branch/ConversationPeople.ts"
import * as ChatMetrics from "./ChatMetrics.vibe"
import * as Flows from "./Flows.vibe"
import * as Expire from "./flows/Expire.ts"
import { shared, tracked } from "./test/branch.ts"
import { answers, harness, recorded, row, rowCount, testFile, uuid } from "./test/harness.ts"

const runtime = testFile("chat")

/** Postgres at an address where nothing listens: every connection is refused. */
const nowhere = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:9/smithers")))

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
const guest: Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest" }
const roleless: Actor = { subject: { kind: "person", id: "person-roleless" }, role: null }

/** ChatApi with a Member signed in on every request, and a model that never answers: nothing on the server calls it. */
const asMember = (options: Parameters<typeof harness>[2] = {}) =>
  harness(runtime, answers("never"), { actor: member, ...options })

/** A question asked through ChatApi. */
const asked = async (text: string) => {
  const h = await asMember()
  const ids = { id: uuid(), answerId: uuid() }
  expect((await h.ask({ ...ids, text })).status).toBe(202)
  return ids
}

/** A `POST /api/questions` whose body arrives in these chunks, then ends, or breaks off. */
const chunked = (
  h: Awaited<ReturnType<typeof harness>>,
  chunks: ReadonlyArray<Uint8Array>,
  end: "close" | "error" = "close",
) =>
  h.fetch("/api/questions", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        if (end === "close") controller.close()
        else controller.error(new Error("connection reset"))
      },
    }),
    duplex: "half",
  } as RequestInit)

const bytes = (...parts: ReadonlyArray<string | ReadonlyArray<number>>) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...new TextEncoder().encode(part)] : part)))

describe("POST /api/questions", () => {
  test("history persistence failing never fails an already stored ask", async () => {
    const branch = await tracked(runtime, "github/octocat/spoon-knife", `history-fault-${uuid()}`)
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    let acquisitions = 0
    const database = Layer.unwrap(Effect.sync(() => ++acquisitions === 3 ? nowhere : scratch.database))
    const h = await asMember({ database })
    const response = await h.ask({ id: uuid(), answerId: uuid(), text: "Hello", conversationId: branch.conversationId })
    expect(response.status).toBe(202)
    expect(h.only("conversation.asked.failed").level).toBe("WARN")
  })

  test("asking adds personal history and later asks leave its archive untouched", async () => {
    const branch = await tracked(runtime, "github/octocat/spoon-knife", `history-${uuid()}`)
    const h = await asMember()
    const ask = () => h.ask({ id: uuid(), answerId: uuid(), text: "Hello", conversationId: branch.conversationId })
    expect((await ask()).status).toBe(202)
    await runtime.runPromise(ConversationPeople.archive(branch.conversationId, member.subject.id, true, Date.now() + 1000))
    expect((await ask()).status).toBe(202)
    const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT archived_at FROM conversation_people WHERE conversation_id = ${branch.conversationId} AND person_id = ${member.subject.id}`))
    expect(rows).toHaveLength(1)
    expect(rows[0].archived_at).not.toBeNull()
  })

  test("inserts the question and a streaming answer, 202 with its transaction's id, and answers nothing", async () => {
    const h = await asMember()
    const ids = { id: uuid(), answerId: uuid() }
    const body = JSON.stringify({ ...ids, text: "  Say hi.  " })
    const response = await h.ask(body)
    expect(response.status).toBe(202)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const { txid } = (await response.json()) as { txid: number }
    const question = await row(runtime, ids.id)
    expect(question).toMatchObject({ role: "user", text: "Say hi.", status: "done", questionId: null })
    // Electric reports the transaction that inserted a row by this id; the browser waits for it.
    expect(question.xmin).toBe(txid)
    const answer = await row(runtime, ids.answerId)
    expect(answer).toMatchObject({ role: "assistant", questionId: ids.id, status: "streaming", text: "" })
    expect(answer.position).toBe(question.position + 1)
    // The browser's agent answers it; ChatApi calls no model, and only starts the answer's expiry (below).
    expect(h.requests).toEqual([])
    expect(h.only("chat.question")).toMatchObject({
      level: "INFO",
      annotations: { status: 202, questionId: ids.id, answerId: ids.answerId, bytes: body.length, expiry: "started" },
    })
    expect(h.count(ChatMetrics.questions, { status: "202" })).toBe(1)
  })

  test("a retry of the same question is 200 { txid: null, existing: true } and changes nothing", async () => {
    const h = await asMember()
    const body = { id: uuid(), answerId: uuid(), text: "Ask me once." }
    expect((await h.ask(body)).status).toBe(202)
    // The same question: its text before trimming and its UUIDs' case may differ.
    const retry = await h.ask({
      id: body.id.toUpperCase(),
      answerId: body.answerId.toUpperCase(),
      text: ` ${body.text}`,
    })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ txid: null, existing: true })
    expect(await rowCount(runtime)).toBe(2)
    expect(h.count(ChatMetrics.questions, { status: "200" })).toBe(1)
    const [, second] = h.line("chat.question")
    expect(second).toMatchObject({ level: "INFO", annotations: { status: 200, existing: true } })
  })

  test.each([
    ["different text", (ids: { id: string; answerId: string }) => ({ ...ids, text: "something else" })],
    [
      "a different answerId",
      (ids: { id: string; answerId: string }) => ({ ...ids, answerId: uuid(), text: "original" }),
    ],
    ["an answer's id", (ids: { id: string; answerId: string }) => ({ id: ids.answerId, answerId: uuid(), text: "hi" })],
  ])("409 for an id already used, with %s, and nothing changes", async (_, retry) => {
    const ids = await asked("original")
    const h = await asMember()
    const response = await h.ask(retry(ids))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ message: "id belongs to another message." })
    expect(await rowCount(runtime)).toBe(2)
    expect(await row(runtime, ids.id)).toMatchObject({ text: "original" })
    expect(h.requests).toHaveLength(0)
    expect(h.only("chat.question")).toMatchObject({
      level: "WARN",
      annotations: { status: 409, errorCode: "id_taken" },
    })
  })

  test("409 when the answer id belongs to another message, and nothing is written", async () => {
    const h = await asMember()
    const answerId = uuid()
    expect((await h.ask({ id: uuid(), answerId, text: "first" })).status).toBe(202)
    const response = await h.ask({ id: uuid(), answerId, text: "second" })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ message: "answerId belongs to another message." })
    expect(await rowCount(runtime)).toBe(2)
    expect(h.line("chat.question")[1]).toMatchObject({
      level: "WARN",
      annotations: { status: 409, errorCode: "answer_id_taken" },
    })
  })

  test("concurrent asks keep each answer right after its question", async () => {
    const h = await asMember()
    const asks = Array.from({ length: 12 }, () => ({ id: uuid(), answerId: uuid() }))
    const responses = await Promise.all(asks.map((ids, n) => h.ask({ ...ids, text: `question ${n}` })))
    expect(responses.map((response) => response.status)).toEqual(asks.map(() => 202))
    for (const ids of asks) {
      expect((await row(runtime, ids.answerId)).position).toBe((await row(runtime, ids.id)).position + 1)
    }
  })

  test.each([
    ["not JSON", "{"],
    ["no text", { id: uuid(), answerId: uuid() }],
    ["an id that is not a UUID", { id: "q1", answerId: uuid(), text: "hi" }],
    ["only whitespace", { id: uuid(), answerId: uuid(), text: " \n\t " }],
    ["8,001 characters", { id: uuid(), answerId: uuid(), text: "x".repeat(8_001) }],
    [
      "the same id twice, in either case",
      { id: "4bf92f35-77b3-4da6-a3ce-929d0e0e4736", answerId: "4BF92F35-77B3-4DA6-A3CE-929D0E0E4736", text: "hi" },
    ],
  ])("400 for %s, with a message and no rows", async (_, body) => {
    const h = await asMember()
    const response = await h.ask(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      message:
        "Send JSON { id, answerId, conversationId, text }: two different UUIDs, a conversation's id and 1 to 8,000 characters of text.",
    })
    expect(await rowCount(runtime)).toBe(0)
    expect(h.count(ChatMetrics.questions, { status: "400" })).toBe(1)
    expect(h.only("chat.question")).toMatchObject({ level: "WARN", annotations: { status: 400, errorCode: "invalid" } })
  })

  test.each([
    ["split across chunks", [bytes([0xe2, 0x82]), bytes([0x28], "\"}")]],
    ["cut off at the end", [bytes([0xe2, 0x82])]],
  ])("400 for malformed UTF-8 %s, and no rows", async (_, rest) => {
    const h = await asMember()
    const head = bytes(`{"id":"${uuid()}","answerId":"${uuid()}","text":"`)
    const response = await chunked(h, [head, ...rest])
    expect(response.status).toBe(400)
    expect(await rowCount(runtime)).toBe(0)
    expect(h.only("chat.question").annotations).toMatchObject({ status: 400, errorCode: "utf8" })
  })

  test("400 for a body that breaks off, and no rows", async () => {
    const h = await asMember()
    const response = await chunked(h, [bytes(`{"id":"${uuid()}"`)], "error")
    expect(response.status).toBe(400)
    expect(await rowCount(runtime)).toBe(0)
    expect(h.only("write.body").annotations).toMatchObject({ status: 400 })
    expect(h.line("chat.question")).toHaveLength(0)
  })

  test("a character split across chunks arrives whole", async () => {
    const h = await asMember()
    const ids = { id: uuid(), answerId: uuid() }
    const head = bytes(`{"id":"${ids.id}","answerId":"${ids.answerId}","text":"`, [0xe2])
    const response = await chunked(h, [head, bytes([0x82, 0xac], "\"}")])
    expect(response.status).toBe(202)
    expect((await row(runtime, ids.id)).text).toBe("€")
  })

  test("8,000 characters after trimming is the longest question", async () => {
    const h = await asMember()
    const ids = { id: uuid(), answerId: uuid() }
    expect((await h.ask({ ...ids, text: ` ${"x".repeat(8_000)} ` })).status).toBe(202)
    expect((await row(runtime, ids.id)).text).toHaveLength(8_000)
  })

  test("413 for a body declared over 64 KiB, before reading it", async () => {
    const h = await asMember()
    const response = await h.fetch("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "65537" },
      body: JSON.stringify({ id: uuid(), answerId: uuid(), text: "small" }),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ code: "too_large" })
    expect(await rowCount(runtime)).toBe(0)
    expect(h.only("write.body").annotations).toMatchObject({ status: 413 })
    expect(h.count(WriteAdmission.bodies, { status: "413" })).toBe(1)
    expect(h.line("chat.question")).toHaveLength(0)
  })

  test("413 for a body that streams past 64 KiB, before any of it is stored; 64 KiB is read", async () => {
    const h = await asMember()
    /** A body of `size` bytes, in 4 KiB chunks with no declared length: a question whose text pads it out. */
    const sized = (size: number) => {
      const empty = JSON.stringify({ id: uuid(), answerId: uuid(), text: "" })
      const encoded = new TextEncoder().encode(empty.replace('""', `"${"x".repeat(size - empty.length)}"`))
      const chunks = Array.from({ length: Math.ceil(size / 4096) }, (_, n) => encoded.slice(n * 4096, (n + 1) * 4096))
      return chunked(h, chunks)
    }
    // 65,536 bytes is read, and refused only for its text of over 8,000 characters.
    expect((await sized(65_536)).status).toBe(400)
    const streamed = await sized(65_537)
    expect(streamed.status).toBe(413)
    expect(await rowCount(runtime)).toBe(0)
    expect(h.count(WriteAdmission.bodies, { status: "413" })).toBe(1)
    expect(h.line("chat.question").map((line) => [line.annotations.errorCode, line.annotations.bytes])).toEqual([
      ["invalid", 65_536],
    ])
    expect(h.only("write.body").annotations).toMatchObject({ status: 413 })
  })

  test("503 when Postgres can't be reached", async () => {
    const h = await asMember({ database: nowhere })
    const response = await h.ask({ id: uuid(), answerId: uuid(), text: "anyone there?" })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ message: "Smithers can't reach its database. Try again." })
    expect(h.only("chat.question")).toMatchObject({
      level: "ERROR",
      annotations: { status: 503, errorCode: "sql:ConnectionError" },
    })
  })

  test("503 when a position is taken, as on a database missing 0003_paired_positions", async () => {
    const step = (by: number) =>
      runtime.runPromise(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql.unsafe(`ALTER TABLE messages ALTER COLUMN position SET INCREMENT BY ${by}`),
        ),
      )
    await step(1)
    try {
      const h = await asMember()
      expect((await h.ask({ id: uuid(), answerId: uuid(), text: "first" })).status).toBe(202)
      const response = await h.ask({ id: uuid(), answerId: uuid(), text: "second" })
      expect(response.status).toBe(503)
      expect(h.line("chat.question")[1]!.annotations).toMatchObject({ status: 503, errorCode: "sql:UniqueViolation" })
      expect(await rowCount(runtime)).toBe(2)
    } finally {
      await step(2)
    }
  })

  test("503 with errorCode database when the database fails some other way", async () => {
    class Misconfigured extends Data.TaggedError("Misconfigured")<{}> {}
    const h = await asMember({ database: Layer.effect(SqlClient.SqlClient, Effect.fail(new Misconfigured())) })
    const response = await h.ask({ id: uuid(), answerId: uuid(), text: "anyone there?" })
    expect(response.status).toBe(503)
    expect(h.only("chat.question").annotations).toMatchObject({ status: 503, errorCode: "database" })
  })

  test("405 for another method, with no rows", async () => {
    const h = await harness(runtime, answers("never"))
    const response = await h.fetch("/api/questions")
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
    expect(h.only("chat.question")).toMatchObject({ level: "WARN", annotations: { status: 405, errorCode: "method" } })
  })

  test("404 for a path ChatApi doesn't serve", async () => {
    const h = await harness(runtime, answers("never"))
    expect((await h.fetch("/api/nothing")).status).toBe(404)
  })

  test.each([
    ["an Error", new RangeError("SENTINEL-crash"), "RangeError"],
    ["a tagged value", { _tag: "Broken", detail: "SENTINEL-crash" }, "Broken"],
    ["a plain object", { detail: "SENTINEL-crash" }, "object"],
    ["a string", "SENTINEL-crash", "string"],
    ["an Error whose name is prose", Object.assign(new Error("x"), { name: "SENTINEL-crash happened" }), "unknown"],
  ])("a crash on %s is 500, logged by the defect's name and never its message", async (_, defect, name) => {
    const h = await asMember({ database: Layer.effect(SqlClient.SqlClient, Effect.die(defect)) })
    const response = await h.ask({ id: uuid(), answerId: uuid(), text: "crash" })
    expect(response.status).toBe(500)
    expect(await response.text()).toBe("")
    expect(h.only("chat.question")).toMatchObject({
      level: "ERROR",
      annotations: { status: 500, errorCode: "defect", defect: name },
    })
    expect(h.count(ChatMetrics.questions, { status: "500" })).toBe(1)
    const [span] = h.span("chat.question")
    expect(span!.attributes.get("error.type")).toBe("defect")
    expect(span!.status).toMatchObject({ _tag: "Ended", exit: { _tag: "Success" } })
    expect(recorded(h)).not.toContain("SENTINEL")
  })
})

// A question belongs to one conversation (decision 0013 §1, docs/features/branch-workspace.md): the branch's it names,
// or the home conversation.
describe("a question's conversation", () => {
  const conversationOf = async (id: string) =>
    (await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly conversationId: string }>`
        SELECT conversation_id AS "conversationId" FROM messages WHERE id = ${id}`)))[0]?.conversationId

  test("is the one it names, its answer with it", async () => {
    const h = await asMember()
    const { conversationId } = await tracked(runtime, "github/octocat/spoon-knife", `chat-${uuid().slice(0, 8)}`)
    const ids = { id: uuid(), answerId: uuid() }
    expect((await h.ask({ ...ids, text: "On the branch", conversationId: conversationId.toUpperCase() })).status)
      .toBe(202)
    expect([await conversationOf(ids.id), await conversationOf(ids.answerId)]).toEqual([conversationId, conversationId])
  })

  test("someone else's branch is asked in only by the people it is shared with to edit: 403 to view, and nothing is written", async () => {
    const h = await asMember()
    const theirs = await tracked(runtime, "github/octocat/spoon-knife", `theirs-${uuid().slice(0, 8)}`, "open", "person-owner")
    const ask = () => h.ask({ id: uuid(), answerId: uuid(), text: "May I?", conversationId: theirs.conversationId })
    const unshared = await ask()
    expect([unshared.status, await unshared.json()]).toEqual([403, { message: "You can view this branch." }])
    await shared(runtime, theirs.branchId, "person-member", "view")
    const viewer = await ask()
    expect([viewer.status, await viewer.json()]).toEqual([403, { message: "You can view this branch." }])
    expect(h.line("chat.question").map((line) => line.annotations.errorCode)).toEqual(["view_only", "view_only"])
    expect(await rowCount(runtime)).toBe(0)
    await shared(runtime, theirs.branchId, "person-member", "edit")
    expect((await ask()).status).toBe(202)
  })

  test("one that doesn't exist is 404, and nothing is written", async () => {
    const h = await asMember()
    const response = await h.ask({ id: uuid(), answerId: uuid(), text: "Anyone?", conversationId: uuid() })
    expect([response.status, await response.json()]).toEqual([404, { message: "No such conversation." }])
    expect(h.only("chat.question")).toMatchObject({ annotations: { status: 404, errorCode: "conversation_not_found" } })
    expect(await rowCount(runtime)).toBe(0)
  })

  test("naming none, with no home conversation to bind it to, is 503, and nothing is written", async () => {
    const h = await asMember({ config: { GITHUB_REPOSITORY: "nobody/nothing" } })
    const response = await h.ask({ id: uuid(), answerId: uuid(), text: "Home?" })
    expect(response.status).toBe(503)
    expect(h.only("chat.question")).toMatchObject({ annotations: { status: 503, errorCode: "no_home" } })
    expect(await rowCount(runtime)).toBe(0)
  })
})

describe("chat/Expire", () => {
  const expiryOf = (answerId: string) => ({
    flow: "chat/Expire",
    executionId: Expire.executionId(answerId),
    payload: { answerId },
  })

  test("asking starts the answer's expiry, one execution per answer; a resend starts the same one again", async () => {
    const h = await asMember()
    const ids = { id: uuid(), answerId: uuid() }
    const other = { id: uuid(), answerId: uuid() }

    expect((await h.ask({ ...ids, text: "Asked" })).status).toBe(202)
    expect((await h.ask({ ...ids, text: "Asked" })).status).toBe(200)
    expect((await h.ask({ ...other, text: "Asked too" })).status).toBe(202)

    // The Durable Object treats the same intent again as a no-op, so the resend's start changes nothing; it is what
    // starts the expiry when the first request's start was lost.
    expect(h.starts).toEqual([expiryOf(ids.answerId), expiryOf(ids.answerId), expiryOf(other.answerId)])
    expect(h.line("chat.question").map((line) => line.annotations.expiry)).toEqual(["started", "started", "started"])
  })

  // An ask is acknowledged only once its expiry is admitted: an answer with no expiry and no device would stream forever
  // (Codex review 4, P2). A refused start is a 503, which the browser's outbox sends again with the same ids.
  test.each([
    ["unavailable", new Flows.StartUnavailable({ errorCode: "rpc" }), "rpc"],
    ["a conflict", new Flows.StartConflict(), "conflict"],
  ])("a start the remote host refuses (%s) is 503, and the outbox's resend starts it", async (_, error, code) => {
    const started: Array<string> = []
    let refuse = true
    const h = await asMember({
      starter: Flows.FlowStarter.of({
        start: (_, { executionId }) =>
          refuse ? Effect.fail(error) : Effect.sync(() => void started.push(executionId)),
      }),
    })
    const ids = { id: uuid(), answerId: uuid() }

    const refused = await h.ask({ ...ids, text: "Asked" })

    expect(refused.status).toBe(503)
    expect(await refused.json()).toEqual({ message: "Smithers couldn't take the question. Try again." })
    expect(await row(runtime, ids.answerId)).toMatchObject({ status: "streaming" })
    expect(h.only("chat.answer.expire")).toMatchObject({
      level: "WARN",
      annotations: { answerId: ids.answerId, outcome: "not_started", errorCode: code },
    })
    expect(h.only("chat.question")).toMatchObject({
      level: "ERROR",
      annotations: { status: 503, errorCode: "expiry_not_started" },
    })
    expect(h.count(Expire.expiries, { outcome: "not_started" })).toBe(1)

    refuse = false
    const resent = await h.ask({ ...ids, text: "Asked" })

    expect(resent.status).toBe(200)
    expect(started).toEqual([Expire.executionId(ids.answerId)])
    expect(h.line("chat.question").at(-1)!.annotations).toMatchObject({ status: 200, existing: true, expiry: "started" })
  })

  test("a caller that goes away after the question is stored still gets its expiry started", async () => {
    const reached = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    const started: Array<string> = []
    const h = await asMember({
      starter: Flows.FlowStarter.of({
        start: (_, { executionId }) =>
          Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => void started.push(executionId))),
          ),
      }),
    })
    const ids = { id: uuid(), answerId: uuid() }
    const caller = new AbortController()

    const response = h.fetch("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ids, text: "Asked" }),
      signal: caller.signal,
    })
    await Effect.runPromise(Deferred.await(reached))
    // The question is stored and its expiry is being started when the caller goes away.
    expect(await row(runtime, ids.answerId)).toMatchObject({ status: "streaming" })
    caller.abort()
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await response.catch(() => undefined)

    await expect.poll(() => started).toEqual([Expire.executionId(ids.answerId)])
  })

  test("a question ChatApi doesn't take starts nothing", async () => {
    const signedOut = await harness(runtime, answers("never"))
    const h = await asMember()

    expect((await signedOut.ask({ id: uuid(), answerId: uuid(), text: "Asked" })).status).toBe(401)
    expect((await h.ask({ id: uuid(), answerId: uuid(), text: "" })).status).toBe(400)

    expect([...signedOut.starts, ...h.starts]).toEqual([])
  })
})

describe("who may ask", () => {
  const question = () => ({ id: uuid(), answerId: uuid(), text: "May I?" })

  test("a signed-out request is 401 before its body is read, and nothing is written", async () => {
    const h = await harness(runtime, answers("never"))
    const response = await h.ask(question())
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: "Sign in to ask Smithers." })
    expect(await rowCount(runtime)).toBe(0)
    expect(h.only("chat.question")).toMatchObject({
      level: "WARN",
      annotations: { status: 401, errorCode: "authentication" },
    })
    expect(h.only("chat.question").annotations).not.toHaveProperty("bytes")
  })

  test.each([
    ["a Guest", guest],
    ["a person with no role", roleless],
  ])("%s is 403, and no streaming answer holds up later turns", async (_, actor) => {
    const h = await harness(runtime, answers("never"), { actor })
    const response = await h.ask(question())
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ message: "Asking Smithers needs the Member role." })
    expect(await rowCount(runtime)).toBe(0)
    expect(h.count(ChatMetrics.questions, { status: "403" })).toBe(1)
    expect(h.only("chat.question").annotations).toMatchObject({ status: 403, errorCode: "forbidden" })
  })

  test("Member, Maintainer and Admin may ask", async () => {
    for (const role of ["member", "maintainer", "admin"] as const) {
      const h = await harness(runtime, answers("never"), { actor: { ...member, role } })
      expect((await h.ask(question())).status).toBe(202)
    }
    expect(await rowCount(runtime)).toBe(6)
  })

  test("sessions that can't be read are 503, logged by their code, and nothing is written", async () => {
    const h = await harness(runtime, answers("never"), {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
    })
    const response = await h.ask(question())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ message: "Smithers can't reach its database. Try again." })
    expect(await rowCount(runtime)).toBe(0)
    expect(h.only("chat.question")).toMatchObject({
      level: "ERROR",
      annotations: { status: 503, errorCode: "@smthrs/mvp/auth/SessionsUnavailable" },
    })
  })
})

describe("traceparent", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736"
  const spanId = "00f067aa0ba902b7"

  test("a well-formed traceparent parents chat.question, and its line carries the trace", async () => {
    const h = await asMember()
    const response = await h.ask({ id: uuid(), answerId: uuid(), text: "trace me" }, {
      traceparent: `00-${traceId}-${spanId}-01`,
    })
    expect(response.status).toBe(202)
    const [question] = h.span("chat.question")
    expect(question!.traceId).toBe(traceId)
    expect(question!.parent).toMatchObject({ _tag: "Some", value: { spanId } })
    // The line is logged inside the span of the same name.
    expect(h.only("chat.question").annotations).toMatchObject({ trace_id: traceId, span_id: question!.spanId })
  })

  test("its sampled flag doesn't stop ChatApi recording the request", async () => {
    const h = await harness(runtime, answers("never"))
    await h.ask("{", { traceparent: `00-${traceId}-${spanId}-00` })
    const [question] = h.span("chat.question")
    expect(question!.traceId).toBe(traceId)
    expect(question!.sampled).toBe(true)
  })

  test.each([
    ["uppercase hex", `00-${traceId.toUpperCase()}-${spanId}-01`],
    ["another version", `01-${traceId}-${spanId}-01`],
    ["a trace id of zeros", `00-${"0".repeat(32)}-${spanId}-01`],
    ["a span id of zeros", `00-${traceId}-${"0".repeat(16)}-01`],
    ["flags that aren't hex", `00-${traceId}-${spanId}-zz`],
    ["anything after it", `00-${traceId}-${spanId}-01-${"x".repeat(4096)}`],
    ["one character short", `00-${traceId}-${spanId}-1`],
  ])("a traceparent with %s parents nothing", async (_, traceparent) => {
    const h = await harness(runtime, answers("never"))
    await h.ask("{", { traceparent })
    const [question] = h.span("chat.question")
    expect(question!.parent._tag).toBe("None")
    expect(question!.traceId).not.toBe(traceId)
  })

  test("b3 headers parent nothing", async () => {
    const h = await harness(runtime, answers("never"))
    await h.ask("{", { b3: `${traceId}-${spanId}-1`, "x-b3-traceid": traceId, "x-b3-spanid": spanId })
    const [question] = h.span("chat.question")
    expect(question!.parent._tag).toBe("None")
    expect(question!.traceId).not.toBe(traceId)
  })
})

describe("POST /api/telemetry/v1/*", () => {
  const resource = { attributes: [{ key: "service.name", value: { stringValue: "smithers-mvp-web" } }] }
  /** An OTLP/JSON logs export of `records`. */
  const logs = (...records: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify({ resourceLogs: [{ resource, scopeLogs: [{ logRecords: records }] }] })
  const attribute = (key: string, stringValue: string) => ({ key, value: { stringValue } })
  const post = (h: Awaited<ReturnType<typeof harness>>, signal: string, body: string) =>
    h.fetch(`/api/telemetry/v1/${signal}`, { method: "POST", headers: { "content-type": "application/json" }, body })
  const relayed = (h: Awaited<ReturnType<typeof harness>>) =>
    h.logs.filter((log) => log.annotations["otlp.signal"] !== undefined)

  test("relays a browser record as one ChatApi log line with only the fields docs/observability.md lists", async () => {
    const h = await harness(runtime, answers("never"))
    const response = await post(
      h,
      "logs",
      logs({
        severityNumber: 13,
        body: { stringValue: "question not sent" },
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        attributes: [
          attribute("answerId", "a-1"),
          attribute("reason", "refused"),
          attribute("exception.type", "TypeError"),
          attribute("exception.message", "SENTINEL-relay"),
          attribute("exception.stacktrace", "SENTINEL-relay at x.ts:1"),
          attribute("question.text", "SENTINEL-relay"),
        ],
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    expect(relayed(h)).toEqual([
      {
        message: "question not sent",
        level: "WARN",
        timestamp: expect.any(String),
        annotations: {
          answerId: "a-1",
          reason: "refused",
          "exception.type": "TypeError",
          "otlp.signal": "logs",
          "service.name": "smithers-mvp-web",
          "otlp.severity": 13,
          trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
          span_id: "00f067aa0ba902b7",
        },
        spans: {},
        fiberId: expect.any(String),
      },
    ])
    expect(recorded(h)).not.toContain("SENTINEL")
  })

  test("drops a span's status message, which can quote an error's", async () => {
    const h = await harness(runtime, answers("never"))
    const body = JSON.stringify({
      resourceSpans: [{
        resource,
        scopeSpans: [{
          spans: [{
            name: "chat.ask",
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
            startTimeUnixNano: "1000000",
            endTimeUnixNano: "3000000",
            attributes: [attribute("outcome", "refused")],
            status: { code: 2, message: "SENTINEL-relay" },
          }],
        }],
      }],
    })
    expect((await post(h, "traces", body)).status).toBe(200)
    expect(relayed(h)).toMatchObject([
      { message: "chat.ask", level: "ERROR", annotations: { outcome: "refused", "otlp.duration_ms": 2 } },
    ])
    expect(recorded(h)).not.toContain("SENTINEL")
  })

  test("drops records the allowlist doesn't name, and counts them", async () => {
    const h = await harness(runtime, answers("never"))
    const response = await post(
      h,
      "logs",
      logs({ body: { stringValue: "anything at all" } }, { body: { stringValue: "chat ready" } }),
    )
    expect(await response.json()).toEqual({
      partialSuccess: { rejectedLogRecords: 1, errorMessage: "dropped 1 records off the allowlist" },
    })
    expect(relayed(h).map((log) => log.message)).toEqual(["chat ready"])
    expect(h.count(OtlpMetric.relayDroppedRecords, { signal: "logs", reason: "not_allowed" })).toBe(1)
  })

  test("relays at most 200 records of one export, and drops the rest", async () => {
    const h = await harness(runtime, answers("never"))
    const records = Array.from({ length: 201 }, () => ({ body: { stringValue: "question asked" } }))
    const response = await post(h, "logs", logs(...records))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      partialSuccess: { rejectedLogRecords: 1, errorMessage: "relayed the first 200 records" },
    })
    expect(relayed(h)).toHaveLength(200)
    expect(h.count(OtlpMetric.relayDroppedRecords, { signal: "logs", reason: "over_limit" })).toBe(1)
  })

  test("413 for an export over 128 KiB, and nothing relayed; 128 KiB is read", async () => {
    const h = await harness(runtime, answers("never"))
    /** An export of `size` bytes: one record whose body pads it out. */
    const sized = (size: number) => {
      const empty = logs({ body: { stringValue: "" } })
      return empty.replace('""', `"${"x".repeat(size - empty.length)}"`)
    }
    expect((await post(h, "logs", sized(131_072))).status).toBe(200)
    expect((await post(h, "logs", sized(131_073))).status).toBe(413)
    expect(relayed(h)).toHaveLength(0)
  })
})

test("what anyone wrote never reaches a log line, span or metric", async () => {
  const sentinel = "SENTINEL-7f3a9c"
  const h = await asMember()
  const ids = { id: uuid(), answerId: uuid() }
  expect((await h.ask({ ...ids, text: `remember ${sentinel}` })).status).toBe(202)
  expect((await h.ask({ id: "not-a-uuid", answerId: uuid(), text: sentinel })).status).toBe(400)
  expect((await h.ask({ id: ids.id, answerId: ids.answerId, text: `retry ${sentinel}` })).status).toBe(409)
  const refused = await harness(runtime, answers("never"), { actor: guest })
  expect((await refused.ask({ id: uuid(), answerId: uuid(), text: sentinel })).status).toBe(403)
  expect((await row(runtime, ids.id)).text).toBe(`remember ${sentinel}`)
  expect(recorded(h)).not.toContain(sentinel)
  expect(recorded(refused)).not.toContain(sentinel)
})
