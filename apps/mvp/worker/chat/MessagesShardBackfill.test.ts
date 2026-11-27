// The backfill (worker/chat/MessagesShardBackfill.vibe): a conversation whose history Postgres held before the bridge,
// written straight into this file's schema of the compose Postgres, reaches its first read of the conversation's real
// shard object over SQLite (src/test/messagesShardHost.ts), through ChatApi's real route as worker/ChatApiProgram.ts
// wires it. Faults are injected where the network is: at the Worker's way to the object (`forward`), and as a database
// nothing listens on. Nothing here stands in for the shard, the route or Postgres.
import { emptyChat, MAX_BODY_LENGTH, type Message } from "@smthrs/app-state"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ShardProtocol } from "@smthrs/sync"
import { type Duration, Effect, Layer, Logger, Metric, Redacted, Schema, type Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../../src/features/auth/contract.ts"
import { ada, branchOf, OWNER_SECRET, ownerIn, type ShardHost, shardHost } from "../../src/test/messagesShardHost.ts"
import { tracked } from "../test/branch.ts"
import { signedIn, testFile, uuid } from "../test/harness.ts"
import * as Backfill from "./MessagesShardBackfill.vibe"
import * as Bridge from "./MessagesShardBridge.ts"
import { MessagesShardBridge } from "./MessagesShardBridge.ts"
import * as Messages from "./MessagesShard.ts"
import * as Routes from "./MessagesShardRoutes.ts"
import * as Source from "./MessagesShardSource.ts"

const runtime = testFile("messages_shard_backfill")
/** Postgres at an address where nothing listens: every connection is refused. */
const nowhere = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:9/smithers")))
/** The author only the Worker's backfill asks the object as (MessagesShardRoutes.ts `BACKFILLER`). */
const BACKFILLER = "worker:backfill"
const decodePull = Schema.decodeUnknownSync(Schema.fromJsonString(ShardProtocol.PullResponse))
const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(ShardProtocol.SnapshotResponse))
/** A phase as the timeline stores one (src/features/timeline/marks.ts `Mark`). */
const span = JSON.stringify({ title: "Plan the sync", summary: "The plan was agreed.", closed: false, covered: 1 })

const sql = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, use))

type Log = ReturnType<typeof StructuredLogger.formatStructured.log>

/**
 * ChatApi's route in front of a host of shards, with the backfill before every forwarded request and the drain before
 * every read, as worker/ChatApiProgram.ts wires them. `fault` decides, for each request the Worker sends an object
 * (`METHOD path`, and how many submits came before it), whether the network loses it. `sent` is every such request.
 */
const world = Effect.fnUntraced(function*(within: Duration.Input = "5 seconds") {
  const host: ShardHost = yield* shardHost()
  const database = Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient)
  const sent: Array<string> = []
  let submits = 0
  const faults = { lose: (_line: string, _submits: number): boolean => false }
  const forward: Routes.Forward<string> = (shard, request) => {
    const line = `${request.method} ${new URL(request.url, "https://messages.internal").pathname}`
    sent.push(line)
    if (line.endsWith("/submit")) submits++
    return faults.lose(line, submits) ? Effect.fail("offline") : host.forward(shard, request)
  }
  const bridge = MessagesShardBridge.make(forward, { within })
  const route = (conversationId: string, path: string, init: RequestInit = {}) =>
    Routes.dispatch(
      forward,
      (_, id) => Effect.succeed(branchOf(id)),
      OWNER_SECRET,
      (id) => Source.drainIn(database, id),
      (id) => Backfill.ensureIn(database, id),
    ).pipe(
      Effect.provideService(MessagesShardBridge, bridge),
      Effect.provide(signedIn(ada)),
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(
        `https://smithers.example/api/conversations/${conversationId}/messages/${path}`,
        { ...init, headers: { [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA } },
      ))),
      Effect.map(HttpServerResponse.toWeb),
    )
  /** A page's first Pull, from the start: the messages its entries fold to. */
  const pull = (conversationId: string) =>
    Effect.gen(function*() {
      const shard = Messages.shardOf(conversationId)
      const query = ShardProtocol.pullQuery({ version: 2, shard, epoch: 0, after: 0, limit: Routes.MAX_PULL_LIMIT })
      const response = yield* route(conversationId, `pull?${query}`)
      expect(response.status).toBe(200)
      const page = decodePull(yield* Effect.promise(() => response.text()))
      if (page._tag !== "Page") return expect.unreachable("a shard read from the start resyncs nobody")
      return Messages.apply(emptyChat, {
        _tag: "Entries",
        entries: page.entries,
        through: { shard, epoch: page.epoch, seq: page.through },
      }).messages
    })
  const snapshot = (conversationId: string) =>
    Effect.gen(function*() {
      const response = yield* route(conversationId, `snapshot?shard=${Messages.shardOf(conversationId)}`)
      expect(response.status).toBe(200)
      return decodeSnapshot(yield* Effect.promise(() => response.text()))
    })
  const head = (conversationId: string) => Effect.map(host.head(conversationId), (position) => position.seq)
  return { host, database, sent, faults, forward, bridge, route, pull, snapshot, head }
})

/** Runs `program` in a world, on this file's database, with its log lines and its counts kept. */
const observed = async <A>(
  program: (w: Effect.Success<ReturnType<typeof world>>) => Effect.Effect<A, unknown, Scope.Scope | SqlClient.SqlClient>,
  within?: Duration.Input,
) => {
  const logs: Array<Log> = []
  const logger = Logger.make((entry) => { logs.push(StructuredLogger.formatStructured.log(entry)) })
  const registry: Metric.MetricRegistry = new Map()
  const value = await runtime.runPromise(Effect.scoped(Effect.flatMap(world(within), program)).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.provideService(Metric.MetricRegistry, registry),
  ))
  const lines = () =>
    logs.filter((log) => log.message === "messages_shard.backfill").map((log) => {
      const { span_id: _, trace_id: __, ...said } = log.annotations as Record<string, unknown>
      return { level: log.level, ...said } as Record<string, unknown>
    })
  return { value, logs, lines }
}

/** How many backfills of `outcome` the registry the program runs under has counted. */
const counted = (outcome: string) =>
  Effect.map(Metric.value(Metric.withAttributes(Backfill.backfills, { outcome })), (state) => state.count)

/** A branch's conversation, with nothing in Postgres yet. */
const conversation = async () =>
  (await tracked(runtime, "github/octocat/spoon-knife", `shard-backfill-${uuid()}`)).conversationId

const question = (conversationId: string, id: string, text: string) =>
  sql((sql) => sql`
    INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${id}, 'user', ${text}, 'done', ${conversationId})`)

interface Answer {
  readonly text: string
  readonly status: "done" | "streaming" | "failed"
  readonly failure?: string
  readonly parts?: ReadonlyArray<object>
  readonly modelId?: string
  readonly stopReason?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
}

const answer = (conversationId: string, id: string, questionId: string, row: Answer) =>
  sql((sql) => sql`
    INSERT INTO messages (id, role, text, status, question_id, failure, model_id, stop_reason, input_tokens,
      output_tokens, parts, conversation_id, updated_at)
    VALUES (${id}, 'assistant', ${row.text}, ${row.status}, ${questionId}, ${row.failure ?? null}, ${row.modelId ?? null},
      ${row.stopReason ?? null}, ${row.inputTokens ?? null}, ${row.outputTokens ?? null},
      ${JSON.stringify(row.parts ?? [])}::jsonb, ${conversationId}, now() + interval '2 seconds')`)

/** Every message Postgres holds of the conversation, in its place, as the shard is to hold it. */
const positions = (conversationId: string) =>
  sql((sql) => sql<{ readonly id: string; readonly position: number }>`
    SELECT id, position::int AS position FROM messages WHERE conversation_id = ${conversationId} ORDER BY position`)

/** What the bridge's text bound keeps of a body past it, cut before a surrogate pair it would part. */
const LONG = "a".repeat(MAX_BODY_LENGTH - 1) + "😀" + "the rest"

/**
 * A conversation as Postgres held it before the bridge: a finished answer with its run, a failed answer, one still
 * streaming, a question with no answer, and an answer past the body bound; notes on a question and on an answer, which
 * no pending row says are owed. Text in several scripts, an emoji and a byte order mark.
 */
const seed = async () => {
  const conversationId = await conversation()
  const id = { q1: uuid(), a1: uuid(), q2: uuid(), a2: uuid(), q3: uuid(), a3: uuid(), q4: uuid(), q5: uuid(), a5: uuid() }
  await question(conversationId, id.q1, "What is a shard? 🧩")
  await answer(conversationId, id.a1, id.q1, {
    text: "﻿One conversation, sequenced. 日本語",
    status: "done",
    parts: [{ id: "step-1", kind: "step", flow: "chat/Answer", status: "done" }],
    modelId: "model-x",
    stopReason: "stop",
    inputTokens: 12,
    outputTokens: 34,
  })
  await question(conversationId, id.q2, "naïve façade")
  await answer(conversationId, id.a2, id.q2, { text: "Partial", status: "failed", failure: "model_error" })
  await question(conversationId, id.q3, "Still answering?")
  await answer(conversationId, id.a3, id.q3, { text: "", status: "streaming" })
  await question(conversationId, id.q4, "Nobody answered this")
  await question(conversationId, id.q5, "Write a lot")
  await answer(conversationId, id.a5, id.q5, { text: LONG, status: "done" })
  await sql((sql) => sql`UPDATE messages SET summary = 'Asked about shards', summary_revision = 'rev1' WHERE id = ${id.q1}`)
  await sql((sql) => sql`UPDATE messages SET phase = ${span} WHERE id = ${id.a1}`)
  // Notes written before the pending table existed: nothing says the shard is owed them but the backfill.
  await sql((sql) => sql`DELETE FROM messages_shard_pending WHERE conversation_id = ${conversationId}`)
  return { conversationId, id }
}

type Seeded = Awaited<ReturnType<typeof seed>>

/** What a reader should see of the seeded conversation: each message's fields the bridge carries from Postgres. */
const expected = async ({ conversationId, id }: Seeded) => {
  const placed = new Map((await positions(conversationId)).map((row) => [row.id, row.position]))
  const shown = (fields: Partial<Message> & { readonly id: string }) => ({ position: placed.get(fields.id), ...fields })
  return [
    shown({ id: id.q1, role: "user", body: "What is a shard? 🧩", status: "posted", summary: "Asked about shards", summaryRevision: "rev1" }),
    shown({
      id: id.a1, role: "assistant", body: "﻿One conversation, sequenced. 日本語", status: "complete", questionId: id.q1,
      parts: [{ id: "step-1", kind: "step", flow: "chat/Answer", status: "done" }], modelId: "model-x", stopReason: "stop",
      inputTokens: 12, outputTokens: 34, phase: span,
    }),
    shown({ id: id.q2, role: "user", body: "naïve façade", status: "posted" }),
    shown({ id: id.a2, role: "assistant", body: "Partial", status: "failed", questionId: id.q2, failure: "model_error" }),
    shown({ id: id.q3, role: "user", body: "Still answering?", status: "posted" }),
    shown({ id: id.a3, role: "assistant", body: "", status: "streaming", questionId: id.q3 }),
    shown({ id: id.q4, role: "user", body: "Nobody answered this", status: "posted" }),
    shown({ id: id.q5, role: "user", body: "Write a lot", status: "posted" }),
    shown({ id: id.a5, role: "assistant", body: "a".repeat(MAX_BODY_LENGTH - 1), status: "complete", questionId: id.q5 }),
  ]
}

/** The fields `expected` names, of each message a reader was given, in their place. */
const seen = (messages: ReadonlyArray<Message>) =>
  [...messages].sort((left, right) => (left.position ?? 0) - (right.position ?? 0)).map((message) => {
    const { id, role, body, status, questionId, position, parts, modelId, stopReason, inputTokens, outputTokens, failure } = message
    const { summary, summaryRevision, phase } = message
    return Object.fromEntries(Object.entries({
      position, id, role, body, status, questionId, parts, modelId, stopReason, inputTokens, outputTokens, failure, summary,
      summaryRevision, phase: phase === "" ? undefined : phase,
    }).filter(([, value]) => value !== undefined))
  })

test("a conversation Postgres held before the bridge reaches its first pull whole, and the line names no text", async () => {
  const seeded = await seed()
  const want = await expected(seeded)
  const { lines, logs } = await observed((w) => Effect.gen(function*() {
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(false)
    expect(seen(yield* w.pull(seeded.conversationId))).toEqual(want)
    // The shard's own state, rebuilt from its SQLite, is what the reader was given.
    expect(seen((yield* w.host.state(seeded.conversationId)).chat.messages)).toEqual(want)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(true)
    expect(yield* counted("backfilled")).toBe(1)
  }))
  expect(lines()).toEqual([{
    level: "INFO", conversationId: seeded.conversationId, outcome: "backfilled", exchanges: 5, notes: 2, refused: 0, transient: 0,
  }])
  for (const text of ["shard? 🧩", "One conversation", "naïve", "Nobody answered", "Asked about shards", "Plan the sync", ada.subject.id]) {
    expect(JSON.stringify(logs)).not.toContain(text)
  }
})

test("pulled again, and at once: nothing is journaled twice, and a marked shard is never read from Postgres again", async () => {
  const seeded = await seed()
  const want = await expected(seeded)
  await observed((w) => Effect.gen(function*() {
    // Four first reads at once: each may find the shard unmarked and replay, and every replay is the same keys.
    const reads = yield* Effect.all([
      w.pull(seeded.conversationId),
      w.pull(seeded.conversationId),
      Effect.as(w.snapshot(seeded.conversationId), undefined),
      w.pull(seeded.conversationId),
    ], { concurrency: "unbounded" })
    for (const read of reads) if (read !== undefined) expect(seen(read)).toEqual(want)
    // Six entries for each ended exchange, three for the streaming one, one for the lone question, one for each note.
    const seq = yield* w.head(seeded.conversationId)
    expect(seq).toBe(6 + 6 + 3 + 1 + 6 + 2)
    const replays = yield* counted("backfilled")
    expect(replays).toBeGreaterThanOrEqual(1)
    expect(replays).toBeLessThanOrEqual(4)

    // Marked: a later read asks the object whether it is, and is served. Nothing is replayed and Postgres is not read,
    // so a row written straight into Postgres now, which no bridge was told of, never reaches the shard.
    const late = uuid()
    yield* Effect.promise(() => question(seeded.conversationId, late, "Written behind the bridge's back"))
    const before = w.sent.length
    const again = yield* w.pull(seeded.conversationId)
    expect(seen(again)).toEqual(want)
    expect(again.map((message) => message.id)).not.toContain(late)
    expect(w.sent.slice(before)).toEqual(["GET /api/messages/backfill", "GET /api/messages/pull"])
    expect(yield* w.head(seeded.conversationId)).toBe(seq)
    expect(yield* counted("backfilled")).toBe(replays)
  }))
})

test("an empty conversation is marked, and its later reads ask Postgres nothing", async () => {
  const conversationId = await conversation()
  const { lines } = await observed((w) => Effect.gen(function*() {
    expect(yield* w.pull(conversationId)).toEqual([])
    expect(yield* counted("empty")).toBe(1)
    expect(yield* w.bridge.backfilled(conversationId)).toBe(true)
    yield* Effect.promise(() => question(conversationId, uuid(), "Asked behind the bridge's back"))
    expect(yield* w.pull(conversationId)).toEqual([])
    expect((yield* w.snapshot(conversationId)).position.seq).toBe(0)
    expect(yield* counted("empty")).toBe(1)
  }))
  expect(lines()).toEqual([{ level: "INFO", conversationId, outcome: "empty", exchanges: 0, notes: 0, refused: 0, transient: 0 }])
})

test("a shard the network lost a command to stays unmarked, and the next read completes it without a duplicate", async () => {
  const seeded = await seed()
  const want = await expected(seeded)
  const { lines } = await observed((w) => Effect.gen(function*() {
    // The second submit the Worker sends never arrives: one exchange's replay stops there.
    w.faults.lose = (line, submits) => line === "POST /api/messages/submit" && submits === 2
    const partial = yield* w.pull(seeded.conversationId)
    expect(seen(partial)).not.toEqual(want)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(false)
    expect(yield* counted("incomplete")).toBe(1)
    w.faults.lose = () => false
    expect(seen(yield* w.pull(seeded.conversationId))).toEqual(want)
    expect(yield* w.head(seeded.conversationId)).toBe(6 + 6 + 3 + 1 + 6 + 2)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(true)
    expect(yield* counted("backfilled")).toBe(1)
  }))
  expect(lines().map((line) => [line.level, line.outcome, line.transient])).toEqual([["WARN", "incomplete", 1], ["INFO", "backfilled", 0]])
})

test("an object that cannot say whether it is marked, or cannot be marked, and a database that cannot be read: the read goes on", async () => {
  const seeded = await seed()
  const want = await expected(seeded)
  const { lines, logs } = await observed((w) => Effect.gen(function*() {
    // The mark cannot be read: nothing is replayed, and the read is served what the shard holds.
    w.faults.lose = (line) => line === "GET /api/messages/backfill"
    expect(yield* w.pull(seeded.conversationId)).toEqual([])
    expect(yield* counted("unreachable")).toBe(1)
    // The history is replayed, and the mark is not set: the next read replays it again, adding nothing.
    w.faults.lose = (line) => line === "POST /api/messages/backfill"
    expect(seen(yield* w.pull(seeded.conversationId))).toEqual(want)
    const seq = yield* w.head(seeded.conversationId)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(false)
    // Postgres cannot be reached: one line, and the shard stays unmarked.
    w.faults.lose = () => false
    yield* Backfill.ensureIn(nowhere, seeded.conversationId).pipe(Effect.provideService(MessagesShardBridge, w.bridge))
    expect(yield* counted("unreadable")).toBe(1)
    // A database that cannot even be built is the same line.
    const unbuildable = Layer.effect(SqlClient.SqlClient, Effect.fail("no database is configured"))
    yield* Backfill.ensureIn(unbuildable, seeded.conversationId).pipe(Effect.provideService(MessagesShardBridge, w.bridge))
    expect(yield* counted("unreadable")).toBe(2)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(false)
    // The database the caller holds, its id in another spelling: replayed again, nothing added, and marked.
    yield* Backfill.ensure(seeded.conversationId.toUpperCase()).pipe(Effect.provideService(MessagesShardBridge, w.bridge))
    expect(yield* w.head(seeded.conversationId)).toBe(seq)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(true)
    // No bridge, or no conversation a shard is named from: the object is asked nothing, and neither is Postgres.
    const before = w.sent.length
    yield* Backfill.ensureIn(nowhere, uuid())
    yield* Backfill.ensureIn(nowhere, "not-a-conversation").pipe(Effect.provideService(MessagesShardBridge, w.bridge))
    expect(w.sent.length).toBe(before)
  }))
  expect(lines().map((line) => [line.level, line.outcome, line.reason])).toEqual([
    ["WARN", "unreachable", undefined],
    ["WARN", "incomplete", "unmarked"],
    ["WARN", "unreadable", undefined],
    ["WARN", "unreadable", undefined],
    ["INFO", "backfilled", undefined],
  ])
  expect(JSON.stringify(logs)).not.toContain("127.0.0.1")
})

test("a row the shard refuses for ever is counted, and the shard is marked all the same: it is never read again", async () => {
  const conversationId = await conversation()
  const asked = uuid()
  await question(conversationId, asked, "A question with a summary the timeline would never write")
  // Markup in a summary: the object refuses the note for what it is, every time it is sent.
  await sql((sql) => sql`UPDATE messages SET summary = '<b>bold</b>', summary_revision = 'rev1' WHERE id = ${asked}`)
  await sql((sql) => sql`DELETE FROM messages_shard_pending WHERE conversation_id = ${conversationId}`)
  const { lines } = await observed((w) => Effect.gen(function*() {
    const read = yield* w.pull(conversationId)
    expect(read.map((message) => [message.id, message.body, message.summary])).toEqual([
      [asked, "A question with a summary the timeline would never write", undefined],
    ])
    expect(yield* w.bridge.backfilled(conversationId)).toBe(true)
    const before = w.sent.length
    yield* w.pull(conversationId)
    expect(w.sent.slice(before)).toEqual(["GET /api/messages/backfill", "GET /api/messages/pull"])
  }))
  expect(lines()).toEqual([{ level: "INFO", conversationId, outcome: "backfilled", exchanges: 1, notes: 1, refused: 1, transient: 0 }])
})

test("a submit is backfilled first: the page's message joins the history Postgres held", async () => {
  const seeded = await seed()
  const want = await expected(seeded)
  const owner = await ownerIn(seeded.conversationId, ada)
  const shard = Messages.shardOf(seeded.conversationId)
  await observed((w) => Effect.gen(function*() {
    const response = yield* w.route(seeded.conversationId, "submit", {
      method: "POST",
      body: JSON.stringify({
        version: 2,
        shard,
        epoch: 0,
        command: {
          key: [`${owner}/tab-1`, "command-1"],
          stream: shard,
          payload: { _tag: "PostMessage", messageId: "page-message-1", author: owner, body: "From a page" },
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ _tag: "Accepted", key: [`${owner}/tab-1`, "command-1"] })
    expect(yield* counted("backfilled")).toBe(1)
    const held = (yield* w.host.state(seeded.conversationId)).chat.messages
    expect(seen(held.filter((message) => message.id !== "page-message-1"))).toEqual(want)
    expect(held.find((message) => message.id === "page-message-1")).toMatchObject({ body: "From a page", author: owner })
  }))
})

test("no page reaches the mark: ChatApi's route has no such path, and the object answers only the Worker's backfill", async () => {
  const seeded = await seed()
  const owner = await ownerIn(seeded.conversationId, ada)
  await observed((w) => Effect.gen(function*() {
    for (const method of ["GET", "POST"]) {
      expect((yield* w.route(seeded.conversationId, "backfill", { method })).status).toBe(404)
    }
    expect(Routes.handles(`/api/conversations/${seeded.conversationId}/messages/backfill`)).toBe(false)
    // Nothing was forwarded for them: not the backfill, not the mark.
    expect(w.sent).toEqual([])
    const shard = Messages.shardOf(seeded.conversationId)
    const direct = (method: string, admission?: object) =>
      Effect.map(
        w.host.forward(shard, HttpServerRequest.fromWeb(new Request("https://messages.internal/api/messages/backfill", {
          method,
          headers: admission === undefined ? {} : { "x-smithers-messages-admission": JSON.stringify(admission) },
        }))),
        (response) => response.status,
      )
    // As a reader, as a writer, with no admission, and as the backfill without leave to write: refused.
    expect(yield* direct("GET", { author: "reader", write: false })).toBe(403)
    expect(yield* direct("POST", { author: owner, write: true })).toBe(403)
    expect(yield* direct("POST")).toBe(403)
    expect(yield* direct("POST", { author: BACKFILLER, write: false })).toBe(403)
    expect(yield* direct("PUT", { author: BACKFILLER, write: true })).toBe(404)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(false)
    // The Worker's own: marked once, and marking again keeps it.
    yield* w.bridge.markBackfilled(seeded.conversationId)
    yield* w.bridge.markBackfilled(seeded.conversationId)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(true)
    // Marked by hand with nothing replayed: the mark is all a read consults.
    expect(yield* w.pull(seeded.conversationId)).toEqual([])
  }))
})

test("the Worker's call for the mark fails as a submit does: refused, an answer that is not one, unreachable, too slow", () =>
  Effect.runPromise(Effect.gen(function*() {
    const shard = Messages.shardOf(uuid())
    const failure = <A>(call: Effect.Effect<A, Routes.SubmitFailed>) => Effect.flip(call)
    expect(yield* failure(Routes.backfilled(() => Effect.succeed(HttpServerResponse.empty({ status: 503 })), shard)))
      .toMatchObject({ reason: "refused", status: 503 })
    expect(yield* failure(Routes.markBackfilled(() => Effect.succeed(HttpServerResponse.text("{\"checked\":")), shard)))
      .toMatchObject({ reason: "invalid_response", status: 200 })
    expect(yield* failure(Routes.backfilled(() => Effect.fail("offline"), shard))).toMatchObject({ reason: "unreachable" })
    expect(yield* failure(Routes.backfilled(() => Effect.die("the binding threw"), shard))).toMatchObject({ reason: "unreachable" })
    const slow = MessagesShardBridge.make(() => Effect.never, { within: "20 millis" })
    expect(yield* failure(slow.backfilled(uuid()))).toMatchObject({ reason: "unreachable" })
    expect(yield* failure(slow.markBackfilled(uuid()))).toMatchObject({ reason: "unreachable" })
  })))

/** A lone question, as the backfill reads one, in a conversation with nothing in Postgres. */
const lone = (conversationId: string, questionId: string = uuid()): Bridge.Lone => ({
  conversationId,
  questionId,
  question: { text: "Replayed", position: 7, createdAt: "2026-11-25 10:00:00+00" },
})
const noteOn = (conversationId: string, messageId: string, summary: string, version = 1): Bridge.Noted => ({
  conversationId,
  messageId,
  role: "user",
  version,
  notes: { summary, summaryRevision: "rev1", phase: "", arc: "" },
})

test("a replay is final when every answer would be the same sent again, and not when the shard was not heard", async () => {
  const conversationId = uuid()
  await observed((w) => Effect.gen(function*() {
    // A post the shard holds in another form stands, and a note the object refuses for what it is is final.
    const kept = uuid()
    const author = Bridge.questionOwner(kept)
    const shard = Messages.shardOf(conversationId)
    yield* Routes.submitAs(w.host.forward, { author }, {
      version: 2,
      shard,
      epoch: 0,
      command: {
        key: [`${author}/${Bridge.BRIDGE_DEVICE}`, `question:${kept}`],
        stream: Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard),
        payload: { _tag: "PostMessage", messageId: kept, author, body: "Posted before posts had places" },
      },
    })
    expect(yield* w.bridge.replayed(lone(conversationId, kept), [noteOn(conversationId, kept, "<refused>")]))
      .toEqual({ outcome: "unavailable", final: true })
    // Two refusals: the first is the one counted.
    const twice = uuid()
    expect(yield* w.bridge.replayed(lone(conversationId, twice), [
      noteOn(conversationId, twice, "<refused>", 1),
      noteOn(conversationId, twice, "fine", 2),
      noteOn(conversationId, twice, "`refused`", 3),
    ])).toEqual({ outcome: "unavailable", final: true })
    // A question whose id is no UUID is no target, and never will be.
    expect(yield* w.bridge.replayed(lone(conversationId, "not-a-uuid"), [])).toEqual({ outcome: "unavailable", final: true })
    expect(yield* w.bridge.replayed(lone(conversationId), [])).toEqual({ outcome: "ok", final: true })
    // The question lost on the way: its notes are not sent.
    const before = w.sent.length
    w.faults.lose = () => true
    expect(yield* w.bridge.replayed(lone(conversationId), [noteOn(conversationId, uuid(), "fine")]))
      .toEqual({ outcome: "unavailable", final: false })
    expect(w.sent.length).toBe(before + 1)
    // The question taken and its note lost.
    const submits = w.sent.filter((line) => line.endsWith("/submit")).length
    w.faults.lose = (_, count) => count === submits + 2
    const noted = uuid()
    expect(yield* w.bridge.replayed(lone(conversationId, noted), [noteOn(conversationId, noted, "fine")]))
      .toEqual({ outcome: "unavailable", final: false })
  }))
  // An object that answers with a status a command's own content never earns, and one that does not answer in time.
  await runtime.runPromise(Effect.gen(function*() {
    const busy = MessagesShardBridge.make(() => Effect.succeed(HttpServerResponse.empty({ status: 503 })))
    expect(yield* busy.replayed(lone(conversationId), [])).toEqual({ outcome: "unavailable", final: false })
    const slow = MessagesShardBridge.make(() => Effect.never, { within: "20 millis" })
    expect(yield* slow.replayed(lone(conversationId), [])).toEqual({ outcome: "timeout", final: false })
  }))
})
