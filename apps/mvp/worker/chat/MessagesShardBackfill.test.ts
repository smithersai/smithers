// The backfill (worker/chat/MessagesShardBackfill.vibe): a conversation whose history Postgres held before the bridge,
// written straight into this file's schema of the compose Postgres, reaches its first read of the conversation's real
// shard object over SQLite (src/test/messagesShardHost.ts), through ChatApi's real route as worker/ChatApiProgram.ts
// wires it. Faults are injected where the network is: at the Worker's way to the object (`forward`), and as a database
// nothing listens on. Nothing here stands in for the shard, the route or Postgres.
import { emptyChat, MAX_BODY_LENGTH, type Message, placesOf } from "@smthrs/app-state"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ShardProtocol } from "@smthrs/sync"
import { type Duration, Effect, Layer, Logger, Metric, Redacted, Schema, type Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient, Statement } from "effect/sql"
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
 * (`METHOD path`, and how many submits and batches came before it), whether the network loses it. `sent` is every
 * such request, `batched` the number of commands of each batch, and `statements` every SQL statement the route ran.
 * `budget` is how many batches one request sends (`Backfill.MAX_BATCHES` unless a test says otherwise).
 */
const world = Effect.fnUntraced(function*(within: Duration.Input = "5 seconds") {
  const host: ShardHost = yield* shardHost()
  const database = Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient)
  const sent: Array<string> = []
  const batched: Array<number> = []
  const statements: Array<string> = []
  let submits = 0
  const faults = {
    lose: (_line: string, _submits: number): boolean => false,
    budget: Backfill.MAX_BATCHES,
    access: {} as Parameters<typeof branchOf>[1],
  }
  const forward: Routes.Forward<string> = (shard, request) =>
    Effect.gen(function*() {
      const line = `${request.method} ${new URL(request.url, "https://messages.internal").pathname}`
      sent.push(line)
      if (line.endsWith("/submit") || line.endsWith("/backfill-batch")) submits++
      if (faults.lose(line, submits)) return yield* Effect.fail("offline")
      if (!line.endsWith("/backfill-batch")) return yield* host.forward(shard, request)
      // A batch is read here once, counted, and sent on as it came.
      const text = yield* Effect.orDie(request.text)
      batched.push((JSON.parse(text) as Messages.BackfillBatch).commands.length)
      return yield* host.forward(shard, HttpServerRequest.fromWeb(new Request(new URL(request.url, "https://messages.internal").href, {
        method: "POST",
        body: text,
        headers: request.headers,
      })))
    })
  const bridge = MessagesShardBridge.make(forward, { within })
  const record: Statement.Transformer = (statement) =>
    Effect.sync(() => {
      statements.push(statement.compile()[0])
      return statement
    })
  const route = (conversationId: string, path: string, init: RequestInit = {}) =>
    Routes.dispatch(
      forward,
      (_, id) => Effect.succeed(branchOf(id, faults.access)),
      OWNER_SECRET,
      (id) => Source.drainIn(database, id),
      (id) => Backfill.ensureIn(database, id, faults.budget),
    ).pipe(
      Effect.provideService(MessagesShardBridge, bridge),
      Effect.provide(signedIn(ada)),
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(
        `https://smithers.example/api/conversations/${conversationId}/messages/${path}`,
        { ...init, headers: { [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA, ...init.headers } },
      ))),
      Effect.provideService(Statement.CurrentTransformer, record),
      Effect.map(HttpServerResponse.toWeb),
    )
  const pullPath = (conversationId: string) => {
    const shard = Messages.shardOf(conversationId)
    return `pull?${ShardProtocol.pullQuery({ version: 2, shard, epoch: 0, after: 0, limit: Routes.MAX_PULL_LIMIT })}`
  }
  /** A page's first Pull, from the start: the messages its entries fold to. */
  const pull = (conversationId: string) =>
    Effect.gen(function*() {
      const shard = Messages.shardOf(conversationId)
      const response = yield* route(conversationId, pullPath(conversationId))
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
  /** A Pull the shard cannot serve yet: `503`, retryable, stored nowhere. */
  const refused = (conversationId: string, path: string = pullPath(conversationId), init: RequestInit = {}) =>
    Effect.gen(function*() {
      const response = yield* route(conversationId, path, init)
      expect([response.status, response.headers.get("retry-after"), response.headers.get("cache-control")])
        .toEqual([503, "1", "no-store"])
      expect(yield* Effect.promise(() => response.json())).toEqual({ error: "shard_backfill_incomplete", retryable: true })
    })
  return { host, database, sent, batched, statements, faults, forward, bridge, route, pullPath, pull, refused, snapshot, head }
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

/** The statements of `statements` that read or write `messages` itself, not the table of what the shard is owed. */
const onMessages = (statements: ReadonlyArray<string>) => statements.filter((statement) => /\bmessages\b/.test(statement))

test("a conversation Postgres held before the bridge reaches its first pull whole, and the line names no text", async () => {
  const seeded = await seed()
  const want = await expected(seeded)
  const { lines, logs } = await observed((w) => Effect.gen(function*() {
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(false)
    const before = w.sent.length
    expect(seen(yield* w.pull(seeded.conversationId))).toEqual(want)
    // One call for the mark, one batch of every command, then the read itself.
    expect(w.sent.slice(before)).toEqual(["GET /internal/backfill-mark", "POST /internal/backfill-batch", "GET /api/messages/pull"])
    // The shard's own state, rebuilt from its SQLite, is what the reader was given.
    expect(seen((yield* w.host.state(seeded.conversationId)).chat.messages)).toEqual(want)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(true)
    expect(yield* counted("backfilled")).toBe(1)
  }))
  // Six commands for each ended exchange, three for the streaming one, one for the lone question, one for each note.
  expect(lines()).toEqual([{
    level: "INFO", conversationId: seeded.conversationId, outcome: "backfilled", exchanges: 5, notes: 2, cursor: 0, batches: 1,
    commands: 6 + 6 + 3 + 1 + 6 + 2,
  }])
  for (const text of ["shard? 🧩", "One conversation", "naïve", "Nobody answered", "Asked about shards", "Plan the sync", ada.subject.id]) {
    expect(JSON.stringify(logs)).not.toContain(text)
  }
})

test("pulled again, and at once: nothing is journaled twice, and a marked shard owed nothing reads no message from Postgres", async () => {
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

    // Marked and owed nothing: a later read asks the object whether it is marked, asks Postgres only what the shard is
    // owed, and is served. No statement touches `messages`.
    let before = w.sent.length
    let ran = w.statements.length
    expect(seen(yield* w.pull(seeded.conversationId))).toEqual(want)
    expect(w.sent.slice(before)).toEqual(["GET /internal/backfill-mark", "GET /api/messages/pull"])
    expect(w.statements.slice(ran)).toHaveLength(1)
    expect(w.statements.slice(ran)[0]).toContain("messages_shard_pending")
    expect(onMessages(w.statements.slice(ran))).toEqual([])

    // A question committed now, which no bridge was told of, is owed to the shard from its commit: the next read's
    // drain delivers it, and the history is not replayed.
    const late = uuid()
    yield* Effect.promise(() => question(seeded.conversationId, late, "Written behind the bridge's back"))
    before = w.sent.length
    const again = yield* w.pull(seeded.conversationId)
    expect(again.map((message) => message.id)).toContain(late)
    expect(w.sent.slice(before)).toEqual(["GET /internal/backfill-mark", "POST /api/messages/submit", "GET /api/messages/pull"])
    expect(yield* w.head(seeded.conversationId)).toBe(seq + 1)
    expect(yield* counted("backfilled")).toBe(replays)
    // Delivered, it is owed nothing again: the read after that touches no message.
    ran = w.statements.length
    yield* w.pull(seeded.conversationId)
    expect(onMessages(w.statements.slice(ran))).toEqual([])
  }))
})

test("an empty conversation is marked, and what is asked in it later reaches the shard as Postgres commits it", async () => {
  const conversationId = await conversation()
  const { lines } = await observed((w) => Effect.gen(function*() {
    expect(yield* w.pull(conversationId)).toEqual([])
    expect(yield* counted("empty")).toBe(1)
    expect(yield* w.bridge.backfilled(conversationId)).toBe(true)
    const asked = uuid()
    yield* Effect.promise(() => question(conversationId, asked, "Asked behind the bridge's back"))
    expect((yield* w.pull(conversationId)).map((message) => message.id)).toEqual([asked])
    expect((yield* w.snapshot(conversationId)).position.seq).toBe(0)
    expect(yield* w.head(conversationId)).toBe(1)
    expect(yield* counted("empty")).toBe(1)
  }))
  expect(lines()).toEqual([{
    level: "INFO", conversationId, outcome: "empty", exchanges: 0, notes: 0, cursor: 0, batches: 1, commands: 0,
  }])
})

test("a batch the network lost is a 503, never part of the history as all of it; the next read completes it without a duplicate", async () => {
  const seeded = await seed()
  const want = await expected(seeded)
  const { lines } = await observed((w) => Effect.gen(function*() {
    w.faults.lose = (line) => line === "POST /internal/backfill-batch"
    yield* w.refused(seeded.conversationId)
    // Nothing was served, and nothing was drained: the read never reached the object.
    expect(w.sent).toEqual(["GET /internal/backfill-mark", "POST /internal/backfill-batch"])
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(false)
    expect(yield* counted("unreachable")).toBe(1)
    // The network is back: the same read is served the whole history, in order.
    w.faults.lose = () => false
    expect(seen(yield* w.pull(seeded.conversationId))).toEqual(want)
    expect(yield* w.head(seeded.conversationId)).toBe(6 + 6 + 3 + 1 + 6 + 2)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(true)
    expect(yield* counted("backfilled")).toBe(1)
  }))
  expect(lines().map((line) => [line.level, line.outcome, line.batches])).toEqual([["WARN", "unreachable", 1], ["INFO", "backfilled", 1]])
})

test("an object that cannot say whether it is marked, or a database that cannot be read: every route is a 503 until it can", async () => {
  const seeded = await seed()
  const want = await expected(seeded)
  const owner = await ownerIn(seeded.conversationId, ada)
  const shard = Messages.shardOf(seeded.conversationId)
  const { lines, logs } = await observed((w) => Effect.gen(function*() {
    // The mark cannot be read: nothing is replayed, and no Pull, Snapshot or Submit is served or sequenced.
    w.faults.lose = (line) => line === "GET /internal/backfill-mark"
    yield* w.refused(seeded.conversationId)
    yield* w.refused(seeded.conversationId, `snapshot?shard=${shard}`)
    yield* w.refused(seeded.conversationId, "submit", {
      method: "POST",
      body: JSON.stringify({
        version: 2,
        shard,
        epoch: 0,
        command: {
          key: [`${owner}/tab-1`, "command-1"],
          stream: shard,
          payload: { _tag: "PostMessage", messageId: "page-message-1", author: owner, body: "Too early" },
        },
      }),
    })
    expect(w.sent.every((line) => line === "GET /internal/backfill-mark")).toBe(true)
    expect(yield* w.head(seeded.conversationId)).toBe(0)
    expect(yield* counted("unreachable")).toBe(3)
    // Postgres cannot be reached: one line, the shard stays unmarked, and the shard is said not to hold the history.
    w.faults.lose = () => false
    expect(yield* Backfill.ensureIn(nowhere, seeded.conversationId).pipe(Effect.provideService(MessagesShardBridge, w.bridge)))
      .toBe(false)
    expect(yield* counted("unreadable")).toBe(1)
    // A database that cannot even be built is the same line.
    const unbuildable = Layer.effect(SqlClient.SqlClient, Effect.fail("no database is configured"))
    expect(yield* Backfill.ensureIn(unbuildable, seeded.conversationId).pipe(Effect.provideService(MessagesShardBridge, w.bridge)))
      .toBe(false)
    expect(yield* counted("unreadable")).toBe(2)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(false)
    // The database the caller holds, its id in another spelling: replayed, and marked.
    expect(yield* Backfill.ensure(seeded.conversationId.toUpperCase()).pipe(Effect.provideService(MessagesShardBridge, w.bridge)))
      .toBe(true)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(true)
    expect(seen(yield* w.pull(seeded.conversationId))).toEqual(want)
    // No bridge, or no conversation a shard is named from: the object is asked nothing, neither is Postgres, and there
    // is nothing to wait for.
    const before = w.sent.length
    expect(yield* Backfill.ensureIn(nowhere, uuid())).toBe(true)
    expect(yield* Backfill.ensureIn(nowhere, "not-a-conversation").pipe(Effect.provideService(MessagesShardBridge, w.bridge))).toBe(true)
    expect(w.sent.length).toBe(before)
  }))
  expect(lines().map((line) => [line.level, line.outcome])).toEqual([
    ["WARN", "unreachable"],
    ["WARN", "unreachable"],
    ["WARN", "unreachable"],
    ["WARN", "unreadable"],
    ["WARN", "unreadable"],
    ["INFO", "backfilled"],
  ])
  expect(JSON.stringify(logs)).not.toContain("127.0.0.1")
})

test("a row the shard refuses is never certified: the read is a 503, the mark stays unset, and the repaired row completes it", async () => {
  const conversationId = await conversation()
  const asked = uuid()
  await question(conversationId, asked, "A question with a summary the timeline would never write")
  // Markup in a summary: the object refuses the note for what it is, every time it is sent.
  await sql((sql) => sql`UPDATE messages SET summary = '<b>bold</b>', summary_revision = 'rev1' WHERE id = ${asked}`)
  await sql((sql) => sql`DELETE FROM messages_shard_pending WHERE conversation_id = ${conversationId}`)
  const { lines, logs } = await observed((w) => Effect.gen(function*() {
    yield* w.refused(conversationId)
    yield* w.refused(conversationId)
    expect(yield* w.bridge.backfilled(conversationId)).toBe(false)
    expect(yield* w.bridge.backfillState(conversationId)).toEqual({ checked: false, cursor: 0 })
    expect(yield* counted("rejected")).toBe(2)
    // The timeline writes the summary again, as it reads: the next read takes it and marks the shard.
    yield* Effect.promise(() => sql((sql) => sql`UPDATE messages SET summary = 'Bold', summary_revision = 'rev2' WHERE id = ${asked}`))
    expect((yield* w.pull(conversationId)).map((message) => [message.id, message.summary, message.noteVersion])).toEqual([
      [asked, "Bold", 2],
    ])
    expect(yield* w.bridge.backfilled(conversationId)).toBe(true)
  }))
  const rejected = {
    level: "WARN", conversationId, outcome: "rejected", exchanges: 1, notes: 1, cursor: 0, batches: 1, commands: 1, messageId: asked,
    code: "invalid",
  }
  expect(lines()).toEqual([rejected, rejected, {
    level: "INFO", conversationId, outcome: "backfilled", exchanges: 1, notes: 1, cursor: 0, batches: 1, commands: 2,
  }])
  expect(JSON.stringify(logs)).not.toContain("bold")
})

test("a question with more than one answer: every answer Postgres holds reaches the shard, in Postgres's order", async () => {
  const conversationId = await conversation()
  const id = { q: uuid(), first: uuid(), second: uuid(), third: uuid() }
  await question(conversationId, id.q, "Answer twice")
  await answer(conversationId, id.first, id.q, { text: "First answer", status: "done" })
  await answer(conversationId, id.second, id.q, { text: "Second answer", status: "failed", failure: "model_error" })
  await answer(conversationId, id.third, id.q, { text: "", status: "streaming" })
  await sql((sql) => sql`DELETE FROM messages_shard_pending WHERE conversation_id = ${conversationId}`)
  const placed = new Map((await positions(conversationId)).map((row) => [row.id, row.position]))
  await observed((w) => Effect.gen(function*() {
    const read = yield* w.pull(conversationId)
    expect(seen(read).map(({ position, id, body, status, questionId }) => [position, id, body, status, questionId])).toEqual([
      [placed.get(id.q), id.q, "Answer twice", "posted", undefined],
      [placed.get(id.first), id.first, "First answer", "complete", id.q],
      [placed.get(id.second), id.second, "Second answer", "failed", id.q],
      [placed.get(id.third), id.third, "", "streaming", id.q],
    ])
    // The question once, then each answer's own commands: six, five and two entries.
    expect(yield* w.head(conversationId)).toBe(6 + 5 + 2)
    expect(yield* w.bridge.backfilled(conversationId)).toBe(true)
  }))
})

test("a question Postgres holds past what a submit carries is cut to the reducer's bound and taken, never refused for its size", async () => {
  const conversationId = await conversation()
  const asked = uuid()
  // Longer than the most bytes the object reads of a command, with an emoji where the bound cuts.
  const text = "q".repeat(MAX_BODY_LENGTH - 1) + "😀" + "q".repeat(Routes.MAX_SHARD_COMMAND_BYTES)
  expect(new TextEncoder().encode(text).length).toBeGreaterThan(Routes.MAX_SHARD_COMMAND_BYTES)
  await question(conversationId, asked, text)
  await sql((sql) => sql`DELETE FROM messages_shard_pending WHERE conversation_id = ${conversationId}`)
  await observed((w) => Effect.gen(function*() {
    const [held] = yield* w.pull(conversationId)
    expect([held!.id, held!.body.length, held!.body]).toEqual([asked, MAX_BODY_LENGTH - 1, "q".repeat(MAX_BODY_LENGTH - 1)])
    expect(yield* w.bridge.backfilled(conversationId)).toBe(true)
  }))
})

test("a pair bridged before posts had places reads after the older history the backfill brings, in Postgres's order", async () => {
  const conversationId = await conversation()
  const id = { olderQ: uuid(), olderA: uuid(), newerQ: uuid(), newerA: uuid() }
  await question(conversationId, id.olderQ, "Older question")
  await answer(conversationId, id.olderA, id.olderQ, { text: "Older answer", status: "done" })
  await question(conversationId, id.newerQ, "Newer question")
  await answer(conversationId, id.newerA, id.newerQ, { text: "Newer answer", status: "done" })
  await sql((sql) => sql`DELETE FROM messages_shard_pending WHERE conversation_id = ${conversationId}`)
  const placed = new Map((await positions(conversationId)).map((row) => [row.id, row.position]))
  const shard = Messages.shardOf(conversationId)
  const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)
  await observed((w) => Effect.gen(function*() {
    // The newer pair, as the bridge of slice 4c posted it: no place, no time. It is the shard's first two entries.
    const post = (messageId: string, author: string, payload: object) =>
      Routes.submitAs(w.host.forward, { author }, {
        version: 2,
        shard,
        epoch: 0,
        command: {
          key: [`${author}/${Bridge.BRIDGE_DEVICE}`, `${author.startsWith("answer:") ? "answer" : "question"}:${messageId}`],
          stream,
          payload: { _tag: "PostMessage", messageId, author, ...payload },
        },
      })
    yield* post(id.newerQ, Bridge.questionOwner(id.newerQ), { body: "Newer question", role: "user" })
    yield* post(id.newerA, Bridge.answerOwner(id.newerA), { body: "", role: "assistant", questionId: id.newerQ })
    // Read as the shard holds it, the newer pair reads first: the order Astra reproduced.
    const raw = (yield* w.host.state(conversationId)).chat.messages
    expect(raw.map((message) => message.id)).toEqual([id.newerQ, id.newerA])
    // The backfill brings the older pair, and keeps the place Postgres gave the newer one: every reader is given it.
    const read = yield* w.pull(conversationId)
    const places = placesOf(read)
    const order = read.map((message, index) => ({ id: message.id, place: places[index]! }))
      .sort((left, right) => left.place - right.place).map((message) => message.id)
    expect(order).toEqual([id.olderQ, id.olderA, id.newerQ, id.newerA])
    expect(read.map((message) => [message.id, message.position])).toEqual([
      [id.newerQ, placed.get(id.newerQ)],
      [id.newerA, placed.get(id.newerA)],
      [id.olderQ, placed.get(id.olderQ)],
      [id.olderA, placed.get(id.olderA)],
    ])
    // The newer answer still ends: the commands after its post are taken.
    expect(read.find((message) => message.id === id.newerA)).toMatchObject({ body: "Newer answer", status: "complete" })
    // A snapshot of the compacted shard gives the same places.
    yield* w.host.compact(conversationId)
    const snapshot = yield* w.snapshot(conversationId)
    const state = (snapshot.state as { readonly chat: { readonly messages: ReadonlyArray<Message> } }).chat.messages
    expect(state.map((message) => [message.id, message.position])).toEqual([
      [id.newerQ, placed.get(id.newerQ)],
      [id.newerA, placed.get(id.newerA)],
      [id.olderQ, placed.get(id.olderQ)],
      [id.olderA, placed.get(id.olderA)],
    ])
  }))
})

/**
 * A conversation of `count` ended exchanges, every question and answer in Postgres before the bridge, and the place
 * Postgres gave each question.
 */
const many = async (count: number) => {
  const conversationId = await conversation()
  const questions = Array.from({ length: count }, () => uuid())
  await sql((sql) =>
    Effect.forEach(questions, (questionId, index) =>
      Effect.andThen(
        sql`INSERT INTO messages (id, role, text, status, conversation_id)
          VALUES (${questionId}, 'user', ${`Question ${index}`}, 'done', ${conversationId})`,
        sql`INSERT INTO messages (id, role, text, status, question_id, conversation_id)
          VALUES (${uuid()}, 'assistant', ${`Answer ${index}`}, 'done', ${questionId}, ${conversationId})`,
      ), { discard: true }))
  await sql((sql) => sql`DELETE FROM messages_shard_pending WHERE conversation_id = ${conversationId}`)
  const asked = new Set<string>(questions)
  const placed = (await positions(conversationId)).filter((row) => asked.has(row.id)).map((row) => row.position)
  return { conversationId, placed }
}

test("200 exchanges are backfilled in seven calls to the object, not 1,200", async () => {
  const { conversationId } = await many(200)
  await observed((w) => Effect.gen(function*() {
    yield* w.pull(conversationId)
    expect(w.sent).toEqual([
      "GET /internal/backfill-mark",
      ...Array.from({ length: 6 }, () => "POST /internal/backfill-batch"),
      "GET /api/messages/pull",
    ])
    expect(w.sent.length - 1).toBeLessThanOrEqual(10)
    expect(w.batched).toEqual([200, 200, 200, 200, 200, 200])
    expect(yield* w.head(conversationId)).toBe(200 * 6)
    expect(yield* w.bridge.backfilled(conversationId)).toBe(true)
  }))
}, 60_000)

test("a backfill cut short by its budget is a 503 that keeps its cursor, and the next read resumes there without resending", async () => {
  const { conversationId, placed } = await many(200)
  const { lines } = await observed((w) => Effect.gen(function*() {
    w.faults.budget = 2
    yield* w.refused(conversationId)
    expect(w.batched).toEqual([200, 200])
    // 400 commands: 66 whole exchanges and four commands of the 67th. The cursor is the 66th question's place.
    const cut = yield* w.bridge.backfillState(conversationId)
    expect(cut).toEqual({ checked: false, cursor: placed[65] })
    expect(yield* w.head(conversationId)).toBe(400)
    // The next read starts after the cursor: the 67th exchange whole, and every one after it, and nothing before.
    w.faults.budget = Backfill.MAX_BATCHES
    yield* w.pull(conversationId)
    expect(w.batched.slice(2)).toEqual([200, 200, 200, 200, 4])
    expect(w.batched.slice(2).reduce((sum, count) => sum + count, 0)).toBe(1200 - 66 * 6)
    expect(yield* w.head(conversationId)).toBe(1200)
    expect(yield* w.bridge.backfillState(conversationId)).toEqual({ checked: true, cursor: placed[199] })
  }))
  expect(lines().map((line) => [line.outcome, line.reason, line.cursor, line.batches, line.commands])).toEqual([
    ["incomplete", "budget", 0, 2, 400],
    ["backfilled", undefined, placed[65], 5, 804],
  ])
}, 60_000)

test("a history longer than one read of Postgres is read a page at a time: the last question read waits for the next request", async () => {
  const conversationId = await conversation()
  await sql((sql) => sql`
    INSERT INTO messages (id, role, text, status, conversation_id)
    SELECT gen_random_uuid(), 'user', 'Question ' || n, 'done', ${conversationId}::uuid
    FROM generate_series(1, ${Backfill.HISTORY_PAGE + 1}) AS n ORDER BY n`)
  await sql((sql) => sql`DELETE FROM messages_shard_pending WHERE conversation_id = ${conversationId}`)
  const placed = (await positions(conversationId)).map((row) => row.position)
  const { lines } = await observed((w) => Effect.gen(function*() {
    // One read holds `HISTORY_PAGE` questions: the last of them may have answers past the page, so it waits.
    yield* w.refused(conversationId)
    expect(w.batched).toEqual([200, 200, 200, 200, 200, 23])
    expect(yield* w.bridge.backfillState(conversationId)).toEqual({ checked: false, cursor: placed[Backfill.HISTORY_PAGE - 2] })
    // The next request reads after the cursor: the two questions left, and the shard is marked.
    yield* w.pull(conversationId)
    expect(w.batched.slice(6)).toEqual([2])
    expect(yield* w.head(conversationId)).toBe(Backfill.HISTORY_PAGE + 1)
    expect(yield* w.bridge.backfilled(conversationId)).toBe(true)
  }))
  expect(lines().map((line) => [line.outcome, line.reason, line.cursor, line.batches, line.commands])).toEqual([
    ["incomplete", "budget", 0, 6, Backfill.HISTORY_PAGE - 1],
    ["backfilled", undefined, placed[Backfill.HISTORY_PAGE - 2], 1, 2],
  ])
}, 60_000)

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

test("a submit the object would refuse never runs the backfill: no write leave, another method, shard or stream, or no request", async () => {
  const seeded = await seed()
  const owner = await ownerIn(seeded.conversationId, ada)
  const shard = Messages.shardOf(seeded.conversationId)
  const other = Messages.shardOf(uuid())
  const submit = (to: string, stream: string) =>
    JSON.stringify({
      version: 2,
      shard: to,
      epoch: 0,
      command: {
        key: [`${owner}/tab-1`, "command-1"],
        stream,
        payload: { _tag: "PostMessage", messageId: "page-message-1", author: owner, body: "Denied" },
      },
    })
  await observed((w) => Effect.gen(function*() {
    const answer = (path: string, init: RequestInit) =>
      Effect.map(w.route(seeded.conversationId, path, init), (response) => [response.status, response.headers.get(Routes.refusalHeader)])
    // A person who may only view the conversation.
    w.faults.access = { access: "view" }
    expect(yield* answer("submit", { method: "POST", body: submit(shard, shard) })).toEqual([403, null])
    w.faults.access = {}
    // Another conversation's shard, or another stream.
    expect(yield* answer("submit", { method: "POST", body: submit(other, other) })).toEqual([403, "wrong_shard"])
    expect(yield* answer("submit", { method: "POST", body: submit(shard, other) })).toEqual([403, "wrong_shard"])
    expect(yield* answer("submit", { method: "POST", body: submit(other, shard) })).toEqual([403, "wrong_shard"])
    // Another method, a read posted to, and a body that is no request.
    expect(yield* answer("submit", {})).toEqual([405, null])
    expect(yield* answer(w.pullPath(seeded.conversationId), { method: "POST", body: "{}" })).toEqual([405, null])
    expect(yield* answer("submit", { method: "POST", body: "{" })).toEqual([400, null])
    // The object was never asked anything, and Postgres was read nothing: no backfill ran, and none was marked.
    expect(w.sent).toEqual([])
    expect(w.statements).toEqual([])
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(false)
    expect(yield* w.head(seeded.conversationId)).toBe(0)
  }))
})

test("no page reaches the mark or a batch: ChatApi's route has no such path, and the object answers only the Worker's backfill", async () => {
  const seeded = await seed()
  const owner = await ownerIn(seeded.conversationId, ada)
  await observed((w) => Effect.gen(function*() {
    for (const path of ["backfill", "backfill-mark", "backfill-batch"]) {
      for (const method of ["GET", "POST"]) {
        expect((yield* w.route(seeded.conversationId, path, { method })).status).toBe(404)
      }
      expect(Routes.handles(`/api/conversations/${seeded.conversationId}/messages/${path}`)).toBe(false)
    }
    // Nothing was forwarded for them: not the backfill, not the mark.
    expect(w.sent).toEqual([])
    const shard = Messages.shardOf(seeded.conversationId)
    const batch = JSON.stringify({ cursor: 0, done: true, commands: [] })
    const direct = (path: string, method: string, admission?: object, body?: string) =>
      Effect.map(
        w.host.forward(shard, HttpServerRequest.fromWeb(new Request(`https://messages.internal${path}`, {
          method,
          ...(body === undefined ? {} : { body }),
          headers: admission === undefined ? {} : { "x-smithers-messages-admission": JSON.stringify(admission) },
        }))),
        (response) => response.status,
      )
    // As a reader, as a writer, with no admission, and as the backfill without leave to write: refused.
    for (const path of [Routes.BACKFILL_MARK_PATH, Routes.BACKFILL_BATCH_PATH]) {
      expect(yield* direct(path, "GET", { author: "reader", write: false })).toBe(403)
      expect(yield* direct(path, "POST", { author: owner, write: true }, batch)).toBe(403)
      expect(yield* direct(path, "POST", undefined, batch)).toBe(403)
      expect(yield* direct(path, "POST", { author: BACKFILLER, write: false }, batch)).toBe(403)
      expect(yield* direct(path, "PUT", { author: BACKFILLER, write: true })).toBe(404)
    }
    // A batch is posted, and it is a batch: a read of the path, or a body that is none, is not.
    expect(yield* direct(Routes.BACKFILL_BATCH_PATH, "GET", { author: BACKFILLER, write: true })).toBe(404)
    expect(yield* direct(Routes.BACKFILL_BATCH_PATH, "POST", { author: BACKFILLER, write: true }, "{\"cursor\":-1}")).toBe(400)
    expect(yield* direct("/api/messages/backfill", "GET", { author: BACKFILLER, write: false })).toBe(404)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(false)
    // The Worker's own: marked once, and marking again keeps it.
    yield* w.bridge.markBackfilled(seeded.conversationId)
    yield* w.bridge.markBackfilled(seeded.conversationId)
    expect(yield* w.bridge.backfilled(seeded.conversationId)).toBe(true)
    // Marked by hand with nothing replayed: the mark is all a read consults.
    expect(yield* w.pull(seeded.conversationId)).toEqual([])
  }))
})

test("the Worker's calls for the mark and a batch fail as a submit does: refused, an answer that is not one, unreachable, too slow", () =>
  Effect.runPromise(Effect.gen(function*() {
    const shard = Messages.shardOf(uuid())
    const batch = { cursor: 0, done: false, commands: [] }
    const failure = <A>(call: Effect.Effect<A, Routes.SubmitFailed>) => Effect.flip(call)
    expect(yield* failure(Routes.backfilled(() => Effect.succeed(HttpServerResponse.empty({ status: 503 })), shard)))
      .toMatchObject({ reason: "refused", status: 503 })
    expect(yield* failure(Routes.markBackfilled(() => Effect.succeed(HttpServerResponse.text("{\"checked\":")), shard)))
      .toMatchObject({ reason: "invalid_response", status: 200 })
    expect(yield* failure(Routes.backfillBatch(() => Effect.succeed(HttpServerResponse.text("{\"applied\":1}")), shard, batch)))
      .toMatchObject({ reason: "invalid_response", status: 200 })
    expect(yield* failure(Routes.backfillBatch(() => Effect.succeed(HttpServerResponse.empty({ status: 413 })), shard, batch)))
      .toMatchObject({ reason: "refused", status: 413 })
    expect(yield* failure(Routes.backfilled(() => Effect.fail("offline"), shard))).toMatchObject({ reason: "unreachable" })
    expect(yield* failure(Routes.backfilled(() => Effect.die("the binding threw"), shard))).toMatchObject({ reason: "unreachable" })
    const slow = MessagesShardBridge.make(() => Effect.never, { within: "20 millis" })
    expect(yield* failure(slow.backfilled(uuid()))).toMatchObject({ reason: "unreachable" })
    expect(yield* failure(slow.markBackfilled(uuid()))).toMatchObject({ reason: "unreachable" })
    expect(yield* failure(slow.backfillState(uuid()))).toMatchObject({ reason: "unreachable" })
    expect(yield* failure(slow.backfillBatch(uuid(), batch))).toMatchObject({ reason: "unreachable" })
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
