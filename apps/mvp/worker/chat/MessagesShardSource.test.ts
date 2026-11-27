// What ChatApi's bridge is told (worker/chat/MessagesShardSource.ts): each write read back from this file's schema of
// the compose Postgres after it committed, through ChatApi's real handler, then sequenced into the conversation's real
// shard object over SQLite (src/test/messagesShardHost.ts). Faults are injected as a database nothing listens on.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Deferred, Effect, Fiber, Layer, Logger, Redacted, type Scope, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { rowsOf } from "../../src/features/chat/messagesShard.ts"
import { type ShardHost, shardHost } from "../../src/test/messagesShardHost.ts"
import type { Actor } from "../Actor.vibe"
import { tracked } from "../test/branch.ts"
import { harness, testFile, uuid } from "../test/harness.ts"
import * as Bridge from "./MessagesShardBridge.ts"
import { MessagesShardBridge } from "./MessagesShardBridge.ts"
import * as Source from "./MessagesShardSource.ts"

const runtime = testFile("messages_shard_source")
const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
const SECRET = "what the person wrote, which no log line may carry"
/** Postgres at an address where nothing listens: every connection is refused. */
const nowhere = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:9/smithers")))

const sql = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, use))

type Log = ReturnType<typeof StructuredLogger.formatStructured.log>

/** Runs `program` over a host of shards, on this file's database, with its bridge lines kept. */
const observed = async <A>(program: (host: ShardHost) => Effect.Effect<A, unknown, Scope.Scope | SqlClient.SqlClient>) => {
  const logs: Array<Log> = []
  const logger = Logger.make((entry) => { logs.push(StructuredLogger.formatStructured.log(entry)) })
  const value = await runtime.runPromise(Effect.scoped(Effect.flatMap(shardHost(), program)).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
  ))
  const lines = () =>
    logs.filter((log) => log.message === "chat.shard.bridge").map((log) => {
      const { span_id: _, trace_id: __, ...said } = log.annotations as Record<string, unknown>
      return said
    })
  return { value, logs, lines }
}

/** A question ChatApi stored in a branch's conversation, with no bridge: Postgres holds the pair, the shard nothing. */
const ask = async (text: string, from: object = {}) => {
  const branch = await tracked(runtime, "github/octocat/spoon-knife", `shard-source-${uuid()}`)
  const h = await harness(runtime, () => Stream.empty, { actor: member })
  const ids = { id: uuid(), answerId: uuid() }
  const response = await h.ask({ ...ids, text, conversationId: branch.conversationId, ...from })
  expect(response.status).toBe(202)
  return { ...ids, conversationId: branch.conversationId, h }
}

/** The pair as Electric delivers it: `position` as a number, each time as Postgres prints it in UTC. */
const stored = (questionId: string) =>
  sql((sql) => sql<{ readonly id: string; readonly position: number; readonly createdAt: string; readonly updatedAt: string }>`
    SELECT id, position::int AS position, (created_at AT TIME ZONE 'UTC')::text || '+00' AS "createdAt",
      (updated_at AT TIME ZONE 'UTC')::text || '+00' AS "updatedAt"
    FROM messages WHERE id = ${questionId} OR question_id = ${questionId} ORDER BY position`)

const bridging = (host: ShardHost) => Effect.provideService(MessagesShardBridge, MessagesShardBridge.make(host.forward))
const messagesOf = (host: ShardHost, conversationId: string) =>
  Effect.map(host.state(conversationId), (state) => state.chat.messages)

test("a question and its answer reach the shard as Postgres committed them: its text, its place and its time", async () => {
  const asked = await ask("What is a shard?")
  const [question, answer] = await stored(asked.id)
  // The answer takes the position after its question's, and Postgres prints a time with its offset.
  expect(answer!.position).toBe(question!.position + 1)
  expect(question!.createdAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00$/)
  const { lines } = await observed((host) => Effect.gen(function*() {
    yield* Source.asked(asked.id).pipe(bridging(host))
    const pending = [
      {
        id: asked.id, author: Bridge.questionOwner(asked.id), body: "What is a shard?", status: "posted", hubSeq: 1,
        role: "user", position: question!.position, createdAt: question!.createdAt,
      },
      {
        id: asked.answerId, author: Bridge.answerOwner(asked.answerId), body: "", status: "streaming", hubSeq: 2,
        role: "assistant", questionId: asked.id, position: answer!.position, createdAt: answer!.createdAt,
      },
    ]
    expect(yield* messagesOf(host, asked.conversationId)).toEqual(pending)
    // An answer Postgres does not hold finished is not bridged as one.
    yield* Source.answered(asked.id).pipe(bridging(host))
    expect(yield* messagesOf(host, asked.conversationId)).toEqual(pending)
    // Finished in Postgres, then read back: the body, when the row was last written, and the end.
    yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE messages SET text = 'One conversation, sequenced.', status = 'done', updated_at = now() + interval '3 seconds'
        WHERE id = ${asked.answerId}`)
    const [, finished] = yield* Effect.promise(() => stored(asked.id))
    expect(finished!.updatedAt).not.toBe(finished!.createdAt)
    yield* Source.answered(asked.id).pipe(bridging(host))
    const done = [pending[0], { ...pending[1], body: "One conversation, sequenced.", status: "complete", updatedAt: finished!.updatedAt }]
    expect(yield* messagesOf(host, asked.conversationId)).toEqual(done)
    const seq = (yield* host.head(asked.conversationId)).seq
    expect(seq).toBe(6)
    // Read again, the same commands under the same keys: nothing is added.
    yield* Source.answered(asked.id).pipe(bridging(host))
    yield* Source.asked(asked.id).pipe(bridging(host))
    expect((yield* host.head(asked.conversationId)).seq).toBe(seq)
    // The rows a page reads off the shard are the rows Electric delivers of Postgres, column for column.
    const rows = rowsOf({ messages: yield* messagesOf(host, asked.conversationId) }, { conversationId: asked.conversationId })
    expect(rows.map((row) => [row.id, row.position, row.createdAt, row.updatedAt])).toEqual([
      [asked.id, question!.position, question!.createdAt, question!.createdAt],
      [asked.answerId, finished!.position, finished!.createdAt, finished!.updatedAt],
    ])
  }))
  // The one line: the answer that was not finished yet.
  expect(lines()).toEqual([{ write: "answered", outcome: "unread", reason: "missing" }])
})

test("an answer to a question the shard never held brings the question with it, in Postgres's order", async () => {
  const first = await ask("Asked before the bridge")
  await sql((sql) => sql`UPDATE messages SET text = 'Answered after it.', status = 'done' WHERE id = ${first.answerId}`)
  await observed((host) => Effect.gen(function*() {
    yield* Source.answered(first.id).pipe(bridging(host))
    expect((yield* messagesOf(host, first.conversationId)).map((message) => [message.id, message.role, message.body, message.status])).toEqual([
      [first.id, "user", "Asked before the bridge", "posted"],
      [first.answerId, "assistant", "Answered after it.", "complete"],
    ])
  }))
})

test("with no bridge nothing is read; with one, a row that cannot be read is a line that carries nothing of it", async () => {
  const asked = await ask(SECRET)
  const { lines, logs } = await observed((host) => Effect.gen(function*() {
    // No bridge: Postgres is never asked, so a database nothing listens on is never noticed.
    yield* Source.askedIn(nowhere, asked.id)
    yield* Source.drain(asked.conversationId).pipe(Effect.provide(nowhere))
    yield* Source.drainIn(nowhere, asked.conversationId)
    // A bridge, and no database: one line each, and the request goes on.
    yield* Source.askedIn(nowhere, asked.id).pipe(bridging(host))
    yield* Source.answered(asked.id).pipe(Effect.provide(nowhere), bridging(host))
    yield* Source.drain(asked.conversationId).pipe(Effect.provide(nowhere), bridging(host))
    yield* Source.drainIn(nowhere, asked.conversationId).pipe(bridging(host))
    // A database that cannot even be built is the same line, and with no bridge it is never built at all.
    const unbuildable = Layer.effect(SqlClient.SqlClient, Effect.fail("no database is configured"))
    yield* Source.drainIn(unbuildable, asked.conversationId)
    yield* Source.drainIn(unbuildable, asked.conversationId).pipe(bridging(host))
    yield* Source.askedIn(unbuildable, asked.id)
    yield* Source.askedIn(unbuildable, asked.id).pipe(bridging(host))
    // A question Postgres does not hold: nothing to bridge.
    yield* Source.asked(uuid()).pipe(bridging(host))
    expect((yield* host.head(asked.conversationId)).seq).toBe(0)
    // The same ask through the database ChatApi was given: bridged.
    yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Source.askedIn(Layer.succeed(SqlClient.SqlClient, sql), asked.id)).pipe(bridging(host))
    expect((yield* messagesOf(host, asked.conversationId)).map((message) => message.body)).toEqual([SECRET, ""])
  }))
  expect(lines()).toEqual([
    { write: "asked", outcome: "unread", reason: "unreadable" },
    { write: "answered", outcome: "unread", reason: "unreadable" },
    { write: "noted", outcome: "unread", reason: "unreadable" },
    { write: "noted", outcome: "unread", reason: "unreadable" },
    { write: "noted", outcome: "unread", reason: "unreadable" },
    { write: "asked", outcome: "unread", reason: "unreadable" },
    { write: "asked", outcome: "unread", reason: "missing" },
  ])
  expect(logs.filter((log) => log.message === "chat.shard.bridge").every((log) => log.level === "WARN")).toBe(true)
  expect(JSON.stringify(logs)).not.toContain(SECRET)
  expect(JSON.stringify(logs)).not.toContain(member.subject.id)
  expect(JSON.stringify(logs)).not.toContain("127.0.0.1")
})

test("a form's submission carries its view and values, which every reader already syncs; a generated view's stay on the server", async () => {
  // In the person's home conversation, where a view is added with no branch named.
  const h = await harness(runtime, () => Stream.empty, { actor: member })
  const form = {
    id: uuid(),
    template: "form",
    props: {
      title: "Which plan?",
      schema: { type: "object", properties: { seats: { type: "number" }, plan: { type: "string" }, yearly: { type: "boolean" } } },
      submitLabel: "Upgrade",
    },
  }
  expect((await h.fetch("/api/views", { method: "POST", body: JSON.stringify(form) })).status).toBe(202)
  const values = { seats: 3, plan: "pro", yearly: true }
  const submitted = { id: uuid(), answerId: uuid() }
  expect((await h.ask({
    ...submitted, text: "Upgrade", source: { viewId: form.id.toUpperCase(), event: "submit" }, data: values,
  })).status).toBe(202)
  const [home] = await sql((sql) => sql<{ readonly conversationId: string }>`
    SELECT conversation_id AS "conversationId" FROM messages WHERE id = ${submitted.id}`)
  const branch = { conversationId: home!.conversationId }
  // A generated view that declares a message event, as ChatApi's presentation realm stores one.
  const generated = uuid()
  await sql((sql) => sql`
    INSERT INTO views (id, template, props, conversation_id, title, size, state, code, html, interactions)
    VALUES (${generated}, 'generated', '{}', ${branch.conversationId}, 'Board', 'inline', '{}', 'export default {}', '<p></p>',
      ${JSON.stringify({ pick: { kind: "message" } })}::jsonb)`)
  const picked = { id: uuid(), answerId: uuid() }
  expect((await h.ask({ ...picked, text: "Pick", source: { viewId: generated, event: "pick" }, data: { cell: SECRET } })).status)
    .toBe(202)
  expect(await sql((sql) => sql`SELECT source, data FROM messages WHERE id = ${picked.id}`))
    .toEqual([{ source: { viewId: generated, event: "pick" }, data: { cell: SECRET } }])

  await observed((host) => Effect.gen(function*() {
    yield* Source.asked(submitted.id).pipe(bridging(host))
    yield* Source.asked(picked.id).pipe(bridging(host))
    const [fromForm, , fromBoard] = yield* messagesOf(host, branch.conversationId)
    // The form's values in one spelling, whatever order Postgres keeps their keys in.
    expect(fromForm).toMatchObject({
      id: submitted.id, body: "Upgrade", role: "user",
      source: { viewId: form.id, event: "submit" }, data: '{"plan":"pro","seats":3,"yearly":true}',
    })
    expect(fromBoard).toMatchObject({ id: picked.id, body: "Pick", role: "user" })
    expect(Object.keys(fromBoard!)).not.toContain("source")
    expect(Object.keys(fromBoard!)).not.toContain("data")
    // What the form's own synced row says is what the shard now says of it, and no more.
    const [view] = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly state: unknown }>`SELECT state FROM views WHERE id = ${form.id}`)
    expect(view!.state).toEqual({ submitted: true, values, questionId: submitted.id })
    const wire = JSON.stringify(yield* host.events(branch.conversationId, 0))
    expect(wire).toContain(form.id)
    expect(wire).not.toContain(generated)
    expect(wire).not.toContain(SECRET)
    // A form that names another question as its submission says nothing for this one.
    yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE views SET state = jsonb_set(state, '{questionId}', to_jsonb(${picked.id}::text)) WHERE id = ${form.id}`)
    const read = yield* Source.exchange(submitted.id)
    expect(read._tag === "Some" && "source" in read.value.question).toBe(false)
    expect(read._tag === "Some" && "data" in read.value.question).toBe(false)
  }))
})

/** A write of a message's notes as the timeline makes one (worker/TimelineSummaries.vibe): it raises the row's version. */
const write = (id: string, fields: Record<string, string | null>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE messages SET ${sql.update(fields)}, notes_version = notes_version + 1 WHERE id = ${id}`)

/** The messages of a conversation whose notes its shard is still owed, with the version each is owed at. */
const owed = (conversationId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly version: number }>`
      SELECT message_id AS id, notes_version::int AS version FROM messages_shard_pending
      WHERE conversation_id = ${conversationId} ORDER BY enqueued_at, message_id`)

/** A shard no request reaches: the Durable Object is down. */
const down = MessagesShardBridge.make(() => Effect.fail("the object cannot be reached"))

test("the timeline's notes reach the shard as Postgres holds them: whole, under the version Postgres counted, a mark taken away included", async () => {
  const asked = await ask("Why a shard?")
  await sql((sql) => sql`UPDATE messages SET text = 'One writer per conversation.', status = 'done' WHERE id = ${asked.answerId}`)
  const phase = JSON.stringify({ title: "Planning", summary: "Chose the shard.", closed: true, covered: 2 })
  const { lines } = await observed((host) => Effect.gen(function*() {
    const rows = Effect.map(messagesOf(host, asked.conversationId), (messages) =>
      rowsOf({ messages }, { conversationId: asked.conversationId }).map((row) => [row.summary, row.summaryRevision, row.phase, row.arc]))
    const versions = Effect.map(messagesOf(host, asked.conversationId), (messages) => messages.map((message) => message.noteVersion))
    yield* Source.answered(asked.id).pipe(bridging(host))
    const head = Effect.map(host.head(asked.conversationId), (at) => at.seq)
    const before = yield* head
    // Nothing is owed, so nothing is sent: an ask and an answer write no note.
    expect(yield* owed(asked.conversationId)).toEqual([])
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    expect(yield* head).toBe(before)
    // The summary Postgres holds, under the revision and the version it holds, is owed from the commit that wrote
    // it: one entry, after which nothing is owed and a second drain sends nothing.
    yield* write(asked.answerId, { summary: "Why one writer", summary_revision: "rev1" })
    expect(yield* owed(asked.conversationId)).toEqual([{ id: asked.answerId, version: 1 }])
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    expect(yield* owed(asked.conversationId)).toEqual([])
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    expect(yield* head).toBe(before + 1)
    expect(yield* versions).toEqual([undefined, 1])
    // A phase and an arc on the question: the answer's notes are as they were.
    yield* write(asked.id, { phase, arc: phase })
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    expect(yield* head).toBe(before + 2)
    expect(yield* rows).toEqual([[null, null, phase, phase], ["Why one writer", "rev1", null, null]])
    // A segmentation that takes the phase away: the shard holds "", which reads as no mark.
    yield* write(asked.id, { phase: null })
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    expect(yield* rows).toEqual([[null, null, null, phase], ["Why one writer", "rev1", null, null]])
    expect((yield* messagesOf(host, asked.conversationId))[0]).toMatchObject({ phase: "", arc: phase, noteVersion: 2 })
    expect(yield* versions).toEqual([2, 1])
    // With no bridge, nothing moves, and the note stays owed until there is one.
    const settled = yield* head
    yield* write(asked.id, { phase })
    yield* Source.drain(asked.conversationId)
    expect(yield* head).toBe(settled)
    expect(yield* owed(asked.conversationId)).toEqual([{ id: asked.id, version: 3 }])
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    expect(yield* owed(asked.conversationId)).toEqual([])
    expect(yield* versions).toEqual([3, 1])
  }))
  expect(lines()).toEqual([])
})

test("Postgres counts a note's version whoever writes it: a Worker that never raises it, one that does, and no write that leaves the notes alone", async () => {
  const asked = await ask("Who counts?")
  await sql((sql) => sql`UPDATE messages SET text = 'Postgres does.', status = 'done' WHERE id = ${asked.answerId}`)
  const version = (id: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.map(sql<{ readonly version: number }>`SELECT notes_version::int AS version FROM messages WHERE id = ${id}`, ([row]) => row!.version))
  const phase = (title: string) => JSON.stringify({ title, summary: "Chose the shard.", closed: false, covered: 1 })
  await observed((host) => Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Finishing the answer wrote no note: no version. What is owed is the exchange Postgres committed, with no notes.
    expect([yield* version(asked.id), yield* version(asked.answerId)]).toEqual([0, 0])
    expect([...(yield* owed(asked.conversationId))].map((row) => row.version)).toEqual([0, 0])
    // A Worker deployed before the column writes each note without it, as its statements always did: the summary with
    // its revision, a phase, an arc, and a mark taken away. Each write is one version, counted under the row's lock.
    yield* sql`UPDATE messages SET summary = 'First', summary_revision = 'rev1' WHERE id = ${asked.answerId}`
    expect(yield* version(asked.answerId)).toBe(1)
    yield* sql`UPDATE messages SET summary_revision = 'rev2' WHERE id = ${asked.answerId}`
    expect(yield* version(asked.answerId)).toBe(2)
    yield* sql`UPDATE messages SET phase = ${phase("Planning")} WHERE id = ${asked.id}`
    yield* sql`UPDATE messages SET arc = ${phase("Arc")} WHERE id = ${asked.id}`
    yield* sql`UPDATE messages SET phase = NULL WHERE id = ${asked.id}`
    expect(yield* version(asked.id)).toBe(3)
    // Both are owed to the shard, at the version Postgres counted, with no statement of that Worker saying so.
    expect([...(yield* owed(asked.conversationId))].sort((left, right) => left.version - right.version))
      .toEqual([{ id: asked.answerId, version: 2 }, { id: asked.id, version: 3 }])
    // A statement that raises the version itself is not counted twice.
    yield* write(asked.answerId, { summary: "Second" })
    expect(yield* version(asked.answerId)).toBe(3)
    // A write that leaves every note as it was counts nothing: the same values again, or another column.
    yield* sql`UPDATE messages SET summary = 'Second', phase = NULL WHERE id = ${asked.answerId}`
    yield* sql`UPDATE messages SET text = 'Postgres does, under the lock.' WHERE id = ${asked.answerId}`
    expect(yield* version(asked.answerId)).toBe(3)
    // The shard is given both as Postgres holds them now, each under its version, and nothing stays owed.
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    expect(yield* owed(asked.conversationId)).toEqual([])
    expect((yield* messagesOf(host, asked.conversationId)).map((message) =>
      [message.id, message.summary, message.summaryRevision, message.phase, message.arc, message.noteVersion])).toEqual([
        [asked.id, undefined, undefined, "", phase("Arc"), 3],
        [asked.answerId, "Second", "rev2", "", "", 3],
      ])
    // A message that leaves Postgres is owed nothing.
    yield* write(asked.answerId, { summary: "Third" })
    expect(yield* owed(asked.conversationId)).toEqual([{ id: asked.answerId, version: 4 }])
    yield* sql`DELETE FROM messages WHERE id = ${asked.answerId}`
    expect(yield* owed(asked.conversationId)).toEqual([])
  }))
})

test("a note read before its message reached the shard brings the message as Postgres holds it: answered, pending, failed, or a question alone", async () => {
  // A finished exchange and a pending one, neither ever bridged: the shard holds nothing of either.
  const finished = await ask("Asked before the bridge")
  await sql((sql) => sql`UPDATE messages SET text = 'Answered after it.', status = 'done' WHERE id = ${finished.answerId}`)
  const pending = await ask("Still being answered")
  const phase = JSON.stringify({ title: "Planning", summary: "Chose the shard.", closed: false, covered: 1 })
  const { lines } = await observed((host) => Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // A summary on the finished answer: its question, the answer whole and its end land first, then the note.
    yield* write(finished.answerId, { summary: "Answered late", summary_revision: "rev1" })
    yield* Source.drain(finished.conversationId).pipe(bridging(host))
    expect((yield* messagesOf(host, finished.conversationId)).map((message) =>
      [message.id, message.role, message.body, message.status, message.summary, message.noteVersion])).toEqual([
        [finished.id, "user", "Asked before the bridge", "posted", undefined, undefined],
        [finished.answerId, "assistant", "Answered after it.", "complete", "Answered late", 1],
      ])
    // A phase on a question whose answer is still pending: the pair lands as an ask posts it, then the note.
    yield* write(pending.id, { phase })
    yield* Source.drain(pending.conversationId).pipe(bridging(host))
    expect((yield* messagesOf(host, pending.conversationId)).map((message) =>
      [message.id, message.role, message.status, message.phase, message.noteVersion])).toEqual([
        [pending.id, "user", "posted", phase, 1],
        [pending.answerId, "assistant", "streaming", undefined, undefined],
      ])
    // The answer's own bridge, arriving after its note, finds its posts there and adds only what is new.
    yield* sql`UPDATE messages SET text = 'Now answered.', status = 'done' WHERE id = ${pending.answerId}`
    yield* Source.answered(pending.id).pipe(bridging(host))
    expect((yield* messagesOf(host, pending.conversationId))[1]).toMatchObject({ body: "Now answered.", status: "complete" })
    // A question Postgres holds with no answer beside it, which no ask leaves and the shard never held: the question
    // itself is posted, at its place, before its note. It never takes a receipt that says the message is missing.
    const orphan = uuid()
    yield* sql`
      INSERT INTO messages (id, role, text, status, conversation_id)
      VALUES (${orphan}, 'user', 'No answer', 'done', ${pending.conversationId})`
    yield* write(orphan, { summary: "Alone", summary_revision: "rev1" })
    yield* Source.drain(pending.conversationId).pipe(bridging(host))
    const [alone] = yield* sql<{ readonly position: number }>`SELECT position::int AS position FROM messages WHERE id = ${orphan}`
    expect((yield* messagesOf(host, pending.conversationId)).at(-1)).toMatchObject({
      id: orphan, author: Bridge.questionOwner(orphan), role: "user", body: "No answer", status: "posted",
      position: alone!.position, summary: "Alone", summaryRevision: "rev1", noteVersion: 1,
    })
    expect(yield* owed(pending.conversationId)).toEqual([])
    // It is no pair, so there is nothing for an ask's or an answer's own bridge to write of it.
    const head = (yield* host.head(pending.conversationId)).seq
    yield* Source.asked(orphan).pipe(bridging(host))
    yield* Source.answered(orphan).pipe(bridging(host))
    expect((yield* host.head(pending.conversationId)).seq).toBe(head)
  }))
  // Nothing was refused: every note found its message, or brought it.
  expect(lines()).toEqual([
    { write: "asked", outcome: "unread", reason: "missing" },
    { write: "answered", outcome: "unread", reason: "missing" },
  ])
})

test("an answer that failed or was abandoned before the shard held it arrives as Postgres holds it, never empty and streaming", async () => {
  const partial = await ask("Asked of a model that broke")
  const abandoned = await ask("Asked and left")
  const streamed = await ask("Asked and pending when it failed")
  const phase = JSON.stringify({ title: "Planning", summary: "Chose the shard.", closed: false, covered: 1 })
  const { lines } = await observed((host) => Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const fail = (id: string, text: string, failure: string) => sql`
      UPDATE messages SET text = ${text}, status = 'failed', failure = ${failure}, updated_at = now() + interval '5 seconds'
      WHERE id = ${id}`
    // Failed part way, with what it had said; and abandoned having said nothing. Neither was ever bridged.
    yield* fail(partial.answerId, "Half an ans", "model_error")
    yield* fail(abandoned.answerId, "", "abandoned")
    yield* write(partial.id, { phase })
    yield* write(abandoned.answerId, { summary: "Left unanswered", summary_revision: "rev1" })
    yield* Source.drain(partial.conversationId).pipe(bridging(host))
    yield* Source.drain(abandoned.conversationId).pipe(bridging(host))
    const [, failed] = yield* Effect.promise(() => stored(partial.id))
    expect(yield* messagesOf(host, partial.conversationId)).toMatchObject([
      { id: partial.id, role: "user", status: "posted", phase, noteVersion: 1 },
      {
        id: partial.answerId, role: "assistant", body: "Half an ans", status: "failed", failure: "model_error",
        updatedAt: failed!.updatedAt, questionId: partial.id,
      },
    ])
    expect(yield* messagesOf(host, abandoned.conversationId)).toMatchObject([
      { id: abandoned.id, role: "user", status: "posted" },
      { id: abandoned.answerId, body: "", status: "failed", failure: "abandoned", summary: "Left unanswered", noteVersion: 1 },
    ])
    // The rows a page reads say what Electric says of Postgres: failed, and why.
    expect(rowsOf({ messages: yield* messagesOf(host, partial.conversationId) }, { conversationId: partial.conversationId })
      .map((row) => [row.role, row.status, row.failure, row.text])).toEqual([
        ["user", "done", null, "Asked of a model that broke"],
        ["assistant", "failed", "model_error", "Half an ans"],
      ])
    // Sent again, the same commands under the same keys: nothing is added, and nothing refused for a status that ended.
    const head = (yield* host.head(partial.conversationId)).seq
    yield* write(partial.id, { arc: phase })
    yield* Source.drain(partial.conversationId).pipe(bridging(host))
    expect((yield* host.head(partial.conversationId)).seq).toBe(head + 1)
    expect((yield* messagesOf(host, partial.conversationId))[1]).toMatchObject({ status: "failed", failure: "model_error" })
    // An answer the shard holds pending, which then fails in Postgres: its failure reaches the shard with the next
    // write that reads the exchange, `answered` as much as a note.
    yield* Source.asked(streamed.id).pipe(bridging(host))
    expect((yield* messagesOf(host, streamed.conversationId))[1]).toMatchObject({ status: "streaming", body: "" })
    yield* fail(streamed.answerId, "Got this far", "unfinished")
    yield* Source.answered(streamed.id).pipe(bridging(host))
    expect((yield* messagesOf(host, streamed.conversationId))[1])
      .toMatchObject({ status: "failed", body: "Got this far", failure: "unfinished" })
  }))
  expect(lines()).toEqual([])
})

test("an answer that failed or was abandoned long ago arrives with what its run wrote: its steps, its model, why it stopped and its token counts", async () => {
  const broken = await ask("Asked of a model that broke after two steps")
  const left = await ask("Asked and left with a step running")
  const finished = await ask("Asked and answered")
  const odd = await ask("Asked of a run with one field no reducer takes")
  const long = await ask("Asked of a run that took more steps than a reducer records")
  const bent = await ask("Asked of a run whose third step no reducer takes")
  const parts = [
    { id: "step-1", kind: "step", flow: "repo/read", status: "done" },
    { id: "step-2", kind: "step", flow: "repo/search", status: "failed" },
  ]
  const running = [{ id: "step-1", kind: "step", flow: "repo/read", status: "running" }]
  const { lines } = await observed((host) => Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const end = (id: string, row: {
      readonly text: string; readonly status: "done" | "failed"; readonly failure: string | null; readonly parts: unknown
      readonly model: string | null; readonly stop: string | null; readonly input: number | null; readonly output: number | null
    }) => sql`
      UPDATE messages SET text = ${row.text}, status = ${row.status}, failure = ${row.failure}, parts = ${JSON.stringify(row.parts)}::jsonb,
        model_id = ${row.model}, stop_reason = ${row.stop}, input_tokens = ${row.input}, output_tokens = ${row.output},
        updated_at = now() + interval '5 seconds'
      WHERE id = ${id}`
    // Each ended in Postgres before any shard held it: a failure with two steps taken and its usage counted, one
    // abandoned with a step still running and nothing counted but a zero, and one that finished.
    yield* end(broken.answerId, { text: "Half an ans", status: "failed", failure: "model_error", parts, model: "fable-5-2", stop: "error", input: 1200, output: 34 })
    yield* end(left.answerId, { text: "", status: "failed", failure: "abandoned", parts: running, model: "fable-5-2", stop: null, input: null, output: 0 })
    yield* end(finished.answerId, { text: "One writer per conversation.", status: "done", failure: null, parts, model: "opus-5-5", stop: "end_turn", input: 900, output: 21 })
    // A run with one field no reducer takes, a model name past its bound: bridged without that field, and with every
    // other one. Stored before the reducer's bounds were, like the two after it.
    yield* end(odd.answerId, { text: "Said this much", status: "failed", failure: "unfinished", parts, model: "m".repeat(300), stop: "error", input: 5, output: 6 })
    // More steps than the reducer records, with a stop reason past its bound: the first 64 steps, and the rest.
    const many = Array.from({ length: 70 }, (_, index) => ({ id: `step-${index}`, kind: "step", flow: "repo/read", status: "done" }))
    yield* end(long.answerId, { text: "After seventy steps", status: "done", failure: null, parts: many, model: "opus-5-5", stop: "s".repeat(300), input: 7, output: 8 })
    // A step the reducer takes none of, third of four: the two before it, in order, and never the one after it.
    const third = [...parts, { id: "i".repeat(300), kind: "step", flow: "repo/read", status: "done" }, { id: "step-4", kind: "step", flow: "repo/read", status: "done" }]
    yield* end(bent.answerId, { text: "After a step too long to name", status: "done", failure: null, parts: third, model: "opus-5-5", stop: "end_turn", input: 9, output: 10 })
    for (const asked of [broken, left, finished, odd, long, bent]) {
      yield* write(asked.answerId, { summary: "Noted long after", summary_revision: "rev1" })
      yield* Source.drain(asked.conversationId).pipe(bridging(host))
      expect(yield* owed(asked.conversationId)).toEqual([])
    }
    const answerOf = (asked: { readonly conversationId: string }) => Effect.map(messagesOf(host, asked.conversationId), (messages) => messages[1]!)
    expect(yield* answerOf(broken)).toMatchObject({
      id: broken.answerId, body: "Half an ans", status: "failed", failure: "model_error",
      parts, modelId: "fable-5-2", stopReason: "error", inputTokens: 1200, outputTokens: 34, summary: "Noted long after",
    })
    const abandoned = yield* answerOf(left)
    expect(abandoned).toMatchObject({ body: "", status: "failed", failure: "abandoned", parts: running, modelId: "fable-5-2", outputTokens: 0 })
    // What Postgres does not hold is not said: no stop reason, no input count.
    expect(abandoned).not.toHaveProperty("stopReason")
    expect(abandoned).not.toHaveProperty("inputTokens")
    expect(yield* answerOf(finished)).toMatchObject({
      body: "One writer per conversation.", status: "complete", parts, modelId: "opus-5-5", stopReason: "end_turn", inputTokens: 900, outputTokens: 21,
    })
    const kept = yield* answerOf(odd)
    expect(kept).toMatchObject({
      body: "Said this much", status: "failed", failure: "unfinished", summary: "Noted long after",
      parts, stopReason: "error", inputTokens: 5, outputTokens: 6,
    })
    expect(kept).not.toHaveProperty("modelId")
    const capped = yield* answerOf(long)
    expect(capped).toMatchObject({ body: "After seventy steps", status: "complete", parts: many.slice(0, 64), modelId: "opus-5-5", inputTokens: 7, outputTokens: 8 })
    expect(capped).not.toHaveProperty("stopReason")
    expect(yield* answerOf(bent)).toMatchObject({
      body: "After a step too long to name", status: "complete", parts, modelId: "opus-5-5", stopReason: "end_turn", inputTokens: 9, outputTokens: 10,
    })
    // The rows a page reads off the shard show the steps and the usage Electric shows of Postgres, column for column.
    for (const asked of [broken, left, finished]) {
      const [, row] = rowsOf({ messages: yield* messagesOf(host, asked.conversationId) }, { conversationId: asked.conversationId })
      const [held] = yield* sql<{
        readonly parts: unknown; readonly modelId: string | null; readonly stopReason: string | null
        readonly inputTokens: number | null; readonly outputTokens: number | null; readonly failure: string | null
      }>`
        SELECT parts, model_id AS "modelId", stop_reason AS "stopReason", input_tokens AS "inputTokens",
          output_tokens AS "outputTokens", failure
        FROM messages WHERE id = ${asked.answerId}`
      expect({ parts: row!.parts, modelId: row!.modelId, stopReason: row!.stopReason, inputTokens: row!.inputTokens, outputTokens: row!.outputTokens, failure: row!.failure })
        .toEqual(held)
    }
    // Read again by a later note, the same commands under the same keys: nothing is refused for a run that is frozen.
    const head = (yield* host.head(broken.conversationId)).seq
    yield* write(broken.answerId, { summary: "Noted again", summary_revision: "rev2" })
    yield* Source.drain(broken.conversationId).pipe(bridging(host))
    expect((yield* host.head(broken.conversationId)).seq).toBe(head + 1)
    expect(yield* answerOf(broken)).toMatchObject({ parts, modelId: "fable-5-2", summary: "Noted again", noteVersion: 2 })
  }))
  expect(lines()).toEqual([])
})

test("an answer Postgres holds longer than a body update carries ends in the shard, cut at a whole character: finished or failed, never left streaming", async () => {
  const done = await ask("Asked when an answer could be any length")
  const failed = await ask("Asked of a model that broke after a long answer")
  // Past the 32,000 units a body update carries, with a pair of surrogates across the bound: unit 31,999 is the first
  // half of the last character a cut at the bound would part.
  const text = `${"a".repeat(31_999)}${"😀".repeat(500)}`
  expect(text.length).toBe(32_999)
  const { lines } = await observed((host) => Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE messages SET text = ${text}, status = 'done', model_id = 'opus-5-5', updated_at = now() + interval '5 seconds' WHERE id = ${done.answerId}`
    yield* sql`UPDATE messages SET text = ${text}, status = 'failed', failure = 'model_error', updated_at = now() + interval '5 seconds' WHERE id = ${failed.answerId}`
    // Each was stored before any shard held it, and a note written since owes the shard its exchange.
    for (const asked of [done, failed]) {
      yield* write(asked.answerId, { summary: "Noted long after", summary_revision: "rev1" })
      yield* Source.drain(asked.conversationId).pipe(bridging(host))
      expect(yield* owed(asked.conversationId)).toEqual([])
    }
    const answerOf = (asked: { readonly conversationId: string }) => Effect.map(messagesOf(host, asked.conversationId), (messages) => messages[1]!)
    const [finished, broke] = [yield* answerOf(done), yield* answerOf(failed)]
    expect(finished).toMatchObject({ status: "complete", modelId: "opus-5-5", summary: "Noted long after" })
    expect(broke).toMatchObject({ status: "failed", failure: "model_error", summary: "Noted long after" })
    for (const answer of [finished, broke]) {
      // The longest whole prefix: the bound less the half character a cut there would leave.
      expect(answer.body.length).toBe(31_999)
      expect(answer.body === text.slice(0, 31_999)).toBe(true)
      expect(answer.body.isWellFormed()).toBe(true)
    }
    // Read again, the same commands under the same keys: nothing is added but the note.
    const head = (yield* host.head(done.conversationId)).seq
    yield* write(done.answerId, { summary: "Noted again", summary_revision: "rev2" })
    yield* Source.drain(done.conversationId).pipe(bridging(host))
    expect((yield* host.head(done.conversationId)).seq).toBe(head + 1)
    expect(yield* answerOf(done)).toMatchObject({ status: "complete", summary: "Noted again" })
  }))
  expect(lines()).toEqual([])
})

/** A bridge over `host` whose shard answers the commands `decide` gives a status for with it, and is real for the rest. */
const deciding = (host: ShardHost, decide: (text: string) => number | undefined) =>
  MessagesShardBridge.make((shard, request) =>
    Effect.gen(function*() {
      const text = yield* Effect.orDie(request.text)
      const status = decide(text)
      if (status !== undefined) return HttpServerResponse.empty({ status })
      return yield* host.forward(shard, HttpServerRequest.fromWeb(new Request("https://messages.internal/api/messages/submit", {
        method: "POST",
        body: text,
        headers: request.headers,
      })))
    }))

/** When each of a conversation's pending rows was last tried, by message, in the order a drain takes them. */
const queue = (conversationId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly tried: boolean }>`
      SELECT message_id AS id, attempted_at IS NOT NULL AS tried FROM messages_shard_pending
      WHERE conversation_id = ${conversationId} ORDER BY attempted_at ASC NULLS FIRST, enqueued_at ASC, message_id`)

test("what is posted before a note never settles it: the row stays owed until the shard answers the note itself", async () => {
  const asked = await ask("Why a shard?")
  await sql((sql) => sql`UPDATE messages SET text = 'One writer per conversation.', status = 'done' WHERE id = ${asked.answerId}`)
  const { lines } = await observed((host) => Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // The shard holds the answer as it ended. Postgres then writes the row again, as a later Worker's write does, and
    // notes it: the exchange read for the note carries a write the shard refuses of an answer that ended.
    yield* Source.answered(asked.id).pipe(bridging(host))
    yield* sql`UPDATE messages SET model_id = 'fable-5-2', updated_at = now() + interval '9 seconds' WHERE id = ${asked.answerId}`
    yield* write(asked.answerId, { summary: "Why one writer", summary_revision: "rev1" })
    // The refusal reaches the bridge, and the note's own command does not reach the shard: nothing has settled the
    // note, so it is still owed. The refused command's receipt is not the note's.
    yield* Source.drain(asked.conversationId).pipe(
      Effect.provideService(MessagesShardBridge, deciding(host, (text) => (text.includes("\"noted:") ? 503 : undefined))),
    )
    expect(yield* owed(asked.conversationId)).toEqual([{ id: asked.answerId, version: 1 }])
    expect(yield* queue(asked.conversationId)).toEqual([{ id: asked.answerId, tried: true }])
    expect((yield* messagesOf(host, asked.conversationId))[1]).not.toHaveProperty("summary")
    // The shard answers the note: only now is the row taken away, though the same command before it is refused again.
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    expect((yield* messagesOf(host, asked.conversationId))[1]).toMatchObject({ status: "complete", summary: "Why one writer", noteVersion: 1 })
    expect(yield* owed(asked.conversationId)).toEqual([])
  }))
  // The replay of the exchange is refused for what it is, with a receipt, both times: that settles the exchange and
  // never the note.
  const refused = {
    write: "replayed", conversationId: asked.conversationId, outcome: "refused", step: "UpdateMessageMetadata", reason: "terminal_metadata",
  }
  expect(lines()).toEqual([
    refused,
    { write: "noted", conversationId: asked.conversationId, outcome: "unavailable", reason: "refused", status: 503, settled: false },
    { write: "noted", outcome: "pending", pending: 1 },
    refused,
  ])
})

test("a drain's worth of notes the shard keeps declining never holds a later note out: what was tried waits behind what was not", async () => {
  const branch = await tracked(runtime, "github/octocat/spoon-knife", `shard-source-${uuid()}`)
  const h = await harness(runtime, () => Stream.empty, { actor: member })
  const conversationId = branch.conversationId
  // 33 exchanges in one conversation: 66 messages, two more than one drain sends.
  const exchanges = Array.from({ length: Source.DRAIN_LIMIT / 2 + 1 }, () => ({ id: uuid(), answerId: uuid() }))
  for (const [index, ids] of exchanges.entries()) {
    expect((await h.ask({ ...ids, text: `Question ${index}`, conversationId })).status).toBe(202)
    await sql((sql) => sql`UPDATE messages SET text = 'Answered.', status = 'done' WHERE id = ${ids.answerId}`)
  }
  const blocked = exchanges.slice(0, -1).flatMap((ids) => [ids.id, ids.answerId])
  const healthy = exchanges.at(-1)!
  await observed((host) => Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // The exchanges Postgres committed are owed first, 66 messages: two drains send them, and nothing is owed.
    yield* Source.drain(conversationId).pipe(bridging(host))
    yield* Source.drain(conversationId).pipe(bridging(host))
    expect(yield* owed(conversationId)).toEqual([])
    const noteAll = (ids: ReadonlyArray<string>) =>
      sql`UPDATE messages SET summary = 'Noted', summary_revision = 'rev1', notes_version = notes_version + 1 WHERE id IN ${sql.in(ids)}`
    // 64 notes are owed first, then one more on the last question.
    yield* noteAll(blocked)
    yield* Effect.sleep(5)
    yield* noteAll([healthy.id])
    expect((yield* owed(conversationId)).length).toBe(Source.DRAIN_LIMIT + 1)
    // The shard cannot take the 64: each of their notes is answered 503, for as long as this lasts.
    const declining = deciding(host, (text) => (blocked.some((id) => text.includes(`"noted:${id}:`)) ? 503 : undefined))
    const drain = Source.drain(conversationId).pipe(Effect.provideService(MessagesShardBridge, declining))
    const summaryOf = (id: string) =>
      Effect.map(messagesOf(host, conversationId), (messages) => messages.find((message) => message.id === id)?.summary)
    // The first drain takes the 64 oldest: none settles, all stay owed, and each is marked tried. The later note was
    // not reached.
    yield* drain
    expect((yield* owed(conversationId)).length).toBe(Source.DRAIN_LIMIT + 1)
    expect(yield* summaryOf(healthy.id)).toBeUndefined()
    const after = yield* queue(conversationId)
    expect(after[0]).toEqual({ id: healthy.id, tried: false })
    expect(after.slice(1).every((row) => row.tried)).toBe(true)
    expect(after.slice(1).map((row) => row.id).sort()).toEqual([...blocked].sort())
    // The second drain starts with the note never tried: it is delivered, though the 64 are still declined.
    yield* drain
    expect(yield* summaryOf(healthy.id)).toBe("Noted")
    expect((yield* owed(conversationId)).map((row) => row.id).sort()).toEqual([...blocked].sort())
    // And however many drains follow, the 64 are tried again each time: nothing is dropped for having been declined.
    yield* drain
    expect((yield* owed(conversationId)).length).toBe(Source.DRAIN_LIMIT)
    // The shard takes them: one drain delivers all 64.
    yield* Source.drain(conversationId).pipe(bridging(host))
    expect(yield* owed(conversationId)).toEqual([])
    expect((yield* messagesOf(host, conversationId)).filter((message) => message.summary === "Noted").length).toBe(Source.DRAIN_LIMIT + 1)
  }))
}, 120_000)

test("a pending row is read, sent and settled in its own conversation only", async () => {
  const here = await ask("Asked here")
  const there = await ask("Asked there")
  await observed((host) => Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Each conversation's own exchange is sent first, and nothing more is owed in either: three entries each.
    yield* Source.drain(here.conversationId).pipe(bridging(host))
    yield* Source.drain(there.conversationId).pipe(bridging(host))
    expect([yield* owed(here.conversationId), yield* owed(there.conversationId)]).toEqual([[], []])
    const sent = 3
    // An exchange is found in the conversation a caller holds it to, and in no other.
    expect((yield* Source.exchange(here.id, here.conversationId))._tag).toBe("Some")
    expect((yield* Source.exchange(here.id, there.conversationId))._tag).toBe("None")
    expect((yield* Source.exchange(here.id))._tag).toBe("Some")
    // A pending row that names another conversation than its message's: draining that conversation sends its shard
    // nothing of this message, and the row is not taken away.
    yield* write(here.id, { summary: "Noted here", summary_revision: "rev1" })
    yield* sql`UPDATE messages_shard_pending SET conversation_id = ${there.conversationId} WHERE message_id = ${here.id}`
    yield* Source.drain(there.conversationId).pipe(bridging(host))
    expect((yield* host.head(there.conversationId)).seq).toBe(sent)
    expect((yield* host.head(here.conversationId)).seq).toBe(sent)
    expect(yield* owed(there.conversationId)).toEqual([{ id: here.id, version: 1 }])
    yield* sql`UPDATE messages_shard_pending SET conversation_id = ${here.conversationId} WHERE message_id = ${here.id}`

    // A row that comes to name another conversation while its note is on its way is not settled by that note's
    // receipt: the delete is held to the conversation the note was sent in.
    const held = yield* holding(host)
    const sending = yield* Source.drain(here.conversationId).pipe(Effect.provideService(MessagesShardBridge, held.bridge), Effect.forkScoped)
    yield* Deferred.await(held.reached)
    yield* sql`UPDATE messages_shard_pending SET conversation_id = ${there.conversationId} WHERE message_id = ${here.id}`
    yield* Deferred.succeed(held.release, undefined)
    yield* Fiber.join(sending)
    expect((yield* messagesOf(host, here.conversationId))[0]).toMatchObject({ id: here.id, summary: "Noted here", noteVersion: 1 })
    expect(yield* owed(there.conversationId)).toEqual([{ id: here.id, version: 1 }])
    expect((yield* host.head(there.conversationId)).seq).toBe(sent)
  }))
})

test("a note the shard could not be given stays owed, and the next drain delivers it: no write is made again", async () => {
  const asked = await ask("Why a shard?")
  await sql((sql) => sql`UPDATE messages SET text = 'One writer per conversation.', status = 'done' WHERE id = ${asked.answerId}`)
  const { lines } = await observed((host) => Effect.gen(function*() {
    // The note commits while the conversation's object cannot be reached: nothing arrives, and the note is still owed.
    yield* write(asked.answerId, { summary: "Why one writer", summary_revision: "rev1" })
    yield* Source.drain(asked.conversationId).pipe(Effect.provideService(MessagesShardBridge, down))
    expect((yield* host.head(asked.conversationId)).seq).toBe(0)
    // The question is owed too: Postgres committed it, and no bridge ever sent it.
    expect([...(yield* owed(asked.conversationId))].sort((left, right) => left.version - right.version))
      .toEqual([{ id: asked.id, version: 0 }, { id: asked.answerId, version: 1 }])
    // The object is back. Nothing writes the note again: the drain a read or a later write runs delivers it, with the
    // exchange it belongs to, which the shard never held either.
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    expect((yield* messagesOf(host, asked.conversationId)).map((message) => [message.id, message.status, message.summary, message.noteVersion]))
      .toEqual([[asked.id, "posted", undefined, undefined], [asked.answerId, "complete", "Why one writer", 1]])
    expect(yield* owed(asked.conversationId)).toEqual([])
  }))
  expect(lines()).toEqual([
    { write: "replayed", conversationId: asked.conversationId, outcome: "unavailable", reason: "unreachable" },
    { write: "noted", outcome: "pending", pending: 2 },
  ])
})

/** A bridge whose notes the network holds on their way to the object: read from Postgres, not yet delivered. */
const holding = (host: ShardHost) =>
  Effect.gen(function*() {
    const reached = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const bridge = MessagesShardBridge.make((shard, request) =>
      Effect.gen(function*() {
        const text = yield* Effect.orDie(request.text)
        if (text.includes("\"noted:")) {
          yield* Deferred.succeed(reached, undefined)
          yield* Deferred.await(release)
        }
        // The same request, sent on: its body was read once here.
        return yield* host.forward(shard, HttpServerRequest.fromWeb(new Request("https://messages.internal/api/messages/submit", {
          method: "POST",
          body: text,
          headers: request.headers,
        })))
      }),
      { within: "20 seconds" })
    return { bridge, reached, release }
  })

test("a note read earlier and delivered later never replaces the newer one, and never settles it: the shard keeps the highest version", async () => {
  const asked = await ask("Why a shard?")
  await sql((sql) => sql`UPDATE messages SET text = 'One writer per conversation.', status = 'done' WHERE id = ${asked.answerId}`)
  const first = JSON.stringify({ title: "Planning", summary: "Chose the shard.", closed: false, covered: 1 })
  const second = JSON.stringify({ title: "Planning", summary: "Chose the shard.", closed: true, covered: 2 })
  const { lines } = await observed((host) => Effect.gen(function*() {
    yield* Source.answered(asked.id).pipe(bridging(host))
    const held = yield* holding(host)
    yield* write(asked.id, { summary: "The older summary", summary_revision: "rev1", phase: first })
    const delayed = yield* Source.drain(asked.conversationId).pipe(Effect.provideService(MessagesShardBridge, held.bridge), Effect.forkScoped)
    yield* Deferred.await(held.reached)
    // A later write commits and is bridged at once: the shard holds it.
    yield* write(asked.id, { summary: "The newer summary", summary_revision: "rev2", phase: second })
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    const newer = { summary: "The newer summary", summaryRevision: "rev2", phase: second, arc: "", noteVersion: 2 }
    expect((yield* messagesOf(host, asked.conversationId))[0]).toMatchObject(newer)
    const head = (yield* host.head(asked.conversationId)).seq
    // The older note arrives: taken with no event, and the newer one stands, whole.
    yield* Deferred.succeed(held.release, undefined)
    yield* Fiber.join(delayed)
    expect((yield* messagesOf(host, asked.conversationId))[0]).toMatchObject(newer)
    expect((yield* host.head(asked.conversationId)).seq).toBe(head + 1)
    expect(yield* host.events(asked.conversationId, head)).toEqual([[]])
    expect(yield* owed(asked.conversationId)).toEqual([])
    // A row a page reads off the shard says what Postgres says now.
    const [row] = rowsOf({ messages: yield* messagesOf(host, asked.conversationId) }, { conversationId: asked.conversationId })
    expect([row!.summary, row!.summaryRevision, row!.phase]).toEqual(["The newer summary", "rev2", second])

    // The other order: a note is written while an earlier one is on its way, and nothing sends it. The earlier one's
    // receipt settles its own version only, so the later note is still owed, and the next drain delivers it.
    const again = yield* holding(host)
    yield* write(asked.id, { summary: "The third summary", summary_revision: "rev3" })
    const sending = yield* Source.drain(asked.conversationId).pipe(Effect.provideService(MessagesShardBridge, again.bridge), Effect.forkScoped)
    yield* Deferred.await(again.reached)
    yield* write(asked.id, { summary: "The fourth summary", summary_revision: "rev4" })
    yield* Deferred.succeed(again.release, undefined)
    yield* Fiber.join(sending)
    expect((yield* messagesOf(host, asked.conversationId))[0]).toMatchObject({ summary: "The third summary", noteVersion: 3 })
    expect(yield* owed(asked.conversationId)).toEqual([{ id: asked.id, version: 4 }])
    yield* Source.drain(asked.conversationId).pipe(bridging(host))
    expect((yield* messagesOf(host, asked.conversationId))[0]).toMatchObject({ summary: "The fourth summary", noteVersion: 4 })
    expect(yield* owed(asked.conversationId)).toEqual([])
  }))
  expect(lines()).toEqual([])
})
