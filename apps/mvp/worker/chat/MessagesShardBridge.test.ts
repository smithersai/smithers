import {
  ChatCommand,
  MAX_BODY_LENGTH,
  MAX_DATA_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_MARK_LENGTH,
  MAX_PARTS,
  MAX_SUMMARY_LENGTH,
  type MessagePart,
} from "@smthrs/app-state"
import { ShardProtocol } from "@smthrs/sync"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Logger, Metric, Schema, type Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import { rowsOf } from "../../src/features/chat/messagesShard.ts"
import { ada, bob, OWNER_SECRET, ownerIn, type ShardHost, shardHost } from "../../src/test/messagesShardHost.ts"
import type { Actor } from "../Actor.vibe"
import { MAX_MESSAGES_SHARD_BYTES } from "../Body.vibe"
import * as Messages from "./MessagesShard.ts"
import * as Bridge from "./MessagesShardBridge.ts"
import { MessagesShardBridge } from "./MessagesShardBridge.ts"
import * as Routes from "./MessagesShardRoutes.ts"
import * as Source from "./MessagesShardSource.ts"

// ChatApi's bridge into the messages shards (decision 0170, slice 4c), over each conversation's real object handler and
// its real SQLite (src/test/messagesShardHost.ts). Faults are injected where the Worker reaches the object: `forward`.

const conversation = "3f2b8c1e-5d4a-4b7e-9c1d-2a6f0e8b7c5d"
const questionId = "11111111-1111-4111-8111-111111111111"
const answerId = "22222222-2222-4222-8222-222222222222"
const shard = Messages.shardOf(conversation)
// The owner names ChatApi admits each person under in this conversation: digests only it can build.
const ADA = await ownerIn(conversation, ada)
const BOB = await ownerIn(conversation, bob)
/** A person whose id no digest and no span id can spell: any trace of them in a log line is a leak. */
const SENTINEL = "asker-sentinel-wxyz"
const asker: Actor = { subject: { kind: "person", id: SENTINEL }, role: "member" }
const ASKER = await ownerIn(conversation, asker)
/** The owner names the bridge writes under: each names its message, and nobody. */
const QUESTION = Bridge.questionOwner(questionId)
const ANSWER = Bridge.answerOwner(answerId)
const SECRET = "what the person wrote, which no log line may carry"
/** Where and when Postgres put the pair: the answer takes the position after its question's. */
const ASKED_AT = "2026-11-25 10:00:00.123456+00"
const ANSWERED_AT = "2026-11-25 10:00:07.5+00"
const question: Bridge.Asked = {
  conversationId: conversation,
  questionId,
  answerId,
  question: { text: SECRET, position: 40, createdAt: ASKED_AT },
  answer: { position: 41, createdAt: ASKED_AT },
}
const answer = (text: string): Bridge.Answered => ({ ...question, text, updatedAt: ANSWERED_AT })
/** The pair as the shard holds it once asked: each with the place and time its post carried. */
const QUESTION_ROW = { id: questionId, author: QUESTION, body: SECRET, status: "posted", hubSeq: 1, role: "user", position: 40, createdAt: ASKED_AT }
const ANSWER_ROW = { id: answerId, author: ANSWER, body: "", status: "streaming", hubSeq: 2, role: "assistant", questionId, position: 41, createdAt: ASKED_AT }
const ANSWERED_ROW = { ...ANSWER_ROW, body: "Because.", status: "complete", updatedAt: ANSWERED_AT }

type Log = ReturnType<typeof StructuredLogger.formatStructured.log>
const decodeSubmit = Schema.decodeUnknownSync(Schema.fromJsonString(ShardProtocol.SubmitRequest))

/** Runs `program` with its log lines and counts kept. */
const observed = async <A>(program: (host: ShardHost) => Effect.Effect<A, unknown, Scope.Scope>) => {
  const logs: Array<Log> = []
  const logger = Logger.make((entry) => { logs.push(StructuredLogger.formatStructured.log(entry)) })
  const registry: Metric.MetricRegistry = new Map()
  const count = (write: string, outcome: string) =>
    Effect.runSync(Metric.value(Metric.withAttributes(Bridge.writes, { write, outcome })).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
    )).count
  const value = await Effect.runPromise(Effect.scoped(Effect.flatMap(shardHost(), program)).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.provideService(Metric.MetricRegistry, registry),
  ))
  /** What each `chat.shard.bridge` line says, without its span's ids. */
  const lines = () =>
    logs.filter((log) => log.message === "chat.shard.bridge").map((log) => {
      const { span_id: _, trace_id: __, ...said } = log.annotations as Record<string, unknown>
      return said
    })
  return { value, logs, count, lines }
}

const seqOf = (host: ShardHost) => Effect.map(host.head(conversation), (head) => head.seq)
const messagesOf = (host: ShardHost) => Effect.map(host.state(conversation), (state) => state.chat.messages)

/** A submit as a signed-in page or run sends one, through ChatApi's real route. */
const submitAs = async (host: ShardHost, actor: Actor, key: readonly [string, string], payload: unknown) => {
  const response = await host.fetchAs(actor)(`https://smithers.example/api/conversations/${conversation}/messages/submit`, {
    method: "POST",
    body: JSON.stringify({ version: 2, shard, epoch: 0, command: { key, stream: shard, payload } }),
  })
  return {
    status: response.status,
    refusal: response.headers.get(Routes.refusalHeader),
    answer: response.status === 200 ? await response.json() as ShardProtocol.SubmitResponse : undefined,
  }
}

test("a question, its pending answer and the answer given are each sequenced once, whatever is sent again", async () => {
  const { lines, count } = await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(question)).toBe("ok")
    const pending = [QUESTION_ROW, ANSWER_ROW]
    expect(yield* messagesOf(host)).toEqual(pending)
    expect(yield* seqOf(host)).toBe(3)
    // The same ask again, as a retried request sends it, and with its ids spelled in capitals: no entry, no row.
    expect(yield* bridge.asked(question)).toBe("ok")
    expect(yield* bridge.asked({
      ...question,
      conversationId: conversation.toUpperCase(),
      questionId: questionId.toUpperCase(),
      answerId: answerId.toUpperCase(),
    })).toBe("ok")
    expect(yield* messagesOf(host)).toEqual(pending)
    expect(yield* seqOf(host)).toBe(3)

    expect(yield* bridge.answered(answer("Because."))).toBe("ok")
    const done = [QUESTION_ROW, ANSWERED_ROW]
    expect(yield* messagesOf(host)).toEqual(done)
    // The body, when Postgres last wrote the row, and the end: one entry each.
    expect(yield* seqOf(host)).toBe(6)
    // The same answer given again, and the ask sent again after it: nothing moves, and nothing goes back to streaming.
    expect(yield* bridge.answered(answer("Because."))).toBe("ok")
    expect(yield* bridge.asked(question)).toBe("ok")
    expect(yield* messagesOf(host)).toEqual(done)
    expect(yield* seqOf(host)).toBe(6)

    // The rows chat reads off the shard: the person's question, and an answer that is nobody's question, each where
    // and when Postgres put it.
    expect(rowsOf({ messages: yield* messagesOf(host) }, { conversationId: conversation }).map((row) =>
      [row.id, row.role, row.text, row.status, row.questionId, row.position, row.createdAt, row.updatedAt])).toEqual([
        [questionId, "user", SECRET, "done", null, 40, ASKED_AT, ASKED_AT],
        [answerId, "assistant", "Because.", "done", questionId, 41, ASKED_AT, ANSWERED_AT],
      ])

    // Another answer once it is finished: Postgres never takes one, and neither does the shard.
    expect(yield* bridge.answered(answer("Because. And more."))).toBe("refused")
    // Other words of the same length reuse the body's key for other content.
    expect(yield* bridge.answered(answer("Because!"))).toBe("idempotency_conflict")
    expect(yield* messagesOf(host)).toEqual(done)
    expect(yield* seqOf(host)).toBe(6)
  }))
  expect(count("asked", "ok")).toBe(4)
  expect(count("answered", "ok")).toBe(2)
  expect(lines()).toEqual([
    { write: "answered", conversationId: conversation, outcome: "refused", step: "UpdateMessageBody", reason: "terminal_body" },
    { write: "answered", conversationId: conversation, outcome: "idempotency_conflict", step: "UpdateMessageBody" },
  ])
})

test("an answer to a question asked before the bridge brings the question and its own pending answer", async () => {
  const { lines } = await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.answered(answer("Because."))).toBe("ok")
    expect(yield* messagesOf(host)).toEqual([QUESTION_ROW, ANSWERED_ROW])
    expect(yield* seqOf(host)).toBe(6)
    // The ask bridged late: every command is its key's receipt.
    expect(yield* bridge.asked(question)).toBe("ok")
    expect(yield* messagesOf(host)).toEqual([QUESTION_ROW, ANSWERED_ROW])
    expect(yield* seqOf(host)).toBe(6)
  }))
  expect(lines()).toEqual([])
})

/** A command as the bridge of slice 4c sent one: the same writer and key, and a post that carried no place. */
const earlier = (host: ShardHost, author: string, id: string, payload: Schema.Json) =>
  Routes.submitAs(host.forward, { author }, {
    version: 2,
    shard,
    epoch: 0,
    command: { key: [`${author}/${Bridge.BRIDGE_DEVICE}`, id], stream: Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard), payload },
  })
const EARLIER_ANSWER = [
  ["answer:" + answerId, { _tag: "PostMessage", messageId: answerId, author: ANSWER, body: "", role: "assistant", questionId }],
  ["streaming:" + answerId, { _tag: "UpdateMessageStatus", messageId: answerId, status: "streaming" }],
] as const

test("a pair an earlier bridge posted without its place stands as it is, and the answer still lands on it", async () => {
  const { lines, count } = await observed((host) => Effect.gen(function*() {
    yield* earlier(host, QUESTION, "question:" + questionId, { _tag: "PostMessage", messageId: questionId, author: QUESTION, body: SECRET, role: "user" })
    for (const [id, payload] of EARLIER_ANSWER) yield* earlier(host, ANSWER, id, payload)
    const bridge = MessagesShardBridge.make(host.forward)
    // The same ask and the answer, now with their places: neither post is taken, and nothing after them is lost.
    expect(yield* bridge.asked(question)).toBe("kept")
    expect(yield* seqOf(host)).toBe(3)
    expect(yield* bridge.answered(answer("Because."))).toBe("kept")
    const { position: _, createdAt: __, ...asked } = QUESTION_ROW
    const { position: ___, createdAt: ____, ...given } = ANSWERED_ROW
    expect(yield* messagesOf(host)).toEqual([asked, given])
    expect(yield* seqOf(host)).toBe(6)
    // Both read in the order the shard sequenced them: neither has a place, so neither is put after a later pair.
    expect(rowsOf({ messages: yield* messagesOf(host) }, { conversationId: conversation }).map((row) => [row.id, row.position]))
      .toEqual([[questionId, 1], [answerId, 2]])
  }))
  expect([count("asked", "kept"), count("answered", "kept")]).toEqual([1, 1])
  expect(lines()).toEqual([
    { write: "asked", conversationId: conversation, outcome: "kept", step: "PostMessage" },
    { write: "answered", conversationId: conversation, outcome: "kept", step: "PostMessage" },
  ])
})

test("a question that reaches the shard after its answer reads before it", async () => {
  await observed((host) => Effect.gen(function*() {
    // An earlier bridge answered a question asked before it: the shard holds the answer alone, with no place.
    for (const [id, payload] of EARLIER_ANSWER) yield* earlier(host, ANSWER, id, payload)
    // The conversation as a page orders it: by each row's position (src/features/chat/queries.ts).
    const read = Effect.map(messagesOf(host), (messages) =>
      [...rowsOf({ messages }, { conversationId: conversation })].sort((left, right) => left.position - right.position)
        .map((row) => [row.id, row.position, row.text]))
    expect(yield* read).toEqual([[answerId, 1, ""]])
    // The answer given again brings its question: posted fourth, placed where Postgres holds it, read first.
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.answered(answer("Because."))).toBe("kept")
    expect((yield* messagesOf(host)).map((message) => [message.id, message.hubSeq, message.position, message.status])).toEqual([
      [answerId, 1, undefined, "complete"],
      [questionId, 3, 40, "posted"],
    ])
    // The answer has no place of its own: it reads straight after the question it answers.
    expect(yield* read).toEqual([[questionId, 40, SECRET], [answerId, 41, "Because."]])
    // A later pair, bridged whole, reads after both.
    const next = {
      ...question,
      questionId: "11111111-1111-4111-8111-111111111112",
      answerId: "22222222-2222-4222-8222-222222222223",
      question: { text: "And then?", position: 42, createdAt: ANSWERED_AT },
      answer: { position: 43, createdAt: ANSWERED_AT },
    }
    expect(yield* bridge.asked(next)).toBe("ok")
    expect((yield* read).map(([id]) => id)).toEqual([questionId, answerId, next.questionId, next.answerId])
  }))
})

test("a question sent from a view carries the view and its values, which only the bridge may say", async () => {
  const viewId = "4444abcd-4444-4444-8444-444444444444"
  const source = { viewId, event: "submit" }
  const data = JSON.stringify({ plan: "pro", seats: 3, yearly: true })
  await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked({ ...question, question: { ...question.question, source, data } })).toBe("ok")
    expect(yield* messagesOf(host)).toEqual([{ ...QUESTION_ROW, source, data }, ANSWER_ROW])
    // The same ask without its view is other content under the question's key: the post that is there stands.
    expect(yield* bridge.asked(question)).toBe("kept")
    expect((yield* messagesOf(host))[0]).toEqual({ ...QUESTION_ROW, source, data })

    // A person's page, and the question's own writer under another id, never say what view a question came from.
    const sourced = (messageId: string, author: string, fields: object = { source, data }) =>
      ({ _tag: "PostMessage", messageId, author, body: "Upgrade", role: "user", ...fields })
    for (const fields of [{ source, data }, { source }, { data }]) {
      expect(yield* Effect.promise(() => submitAs(host, ada, [ADA + "/laptop", "1"], sourced("ada-1", ADA, fields))))
        .toMatchObject({ status: 403, refusal: "reserved" })
    }
    const other = "55555555-5555-4555-8555-555555555555"
    const asBridge = (messageId: string, fields: object) =>
      Effect.flip(earlier(host, Bridge.questionOwner(messageId), "question:" + messageId, sourced(messageId, Bridge.questionOwner(messageId), fields)))
    // What the bridge's own writer says of a view is held to what ChatApi stores of one.
    const unreadable: ReadonlyArray<object> = [
      { data },
      { source: { viewId: viewId.toUpperCase(), event: "submit" } },
      { source: { viewId: "view-1", event: "submit" } },
      { source: { viewId, event: "" } },
      { source: { viewId, event: "has space" } },
      { source, data: "[1]" },
      { source, data: "{\"nested\":{\"deep\":1}}" },
      { source, data: "{" },
      { source, data: JSON.stringify({ big: "x".repeat(16 * 1024) }) },
      { source, role: "assistant" },
    ]
    for (const fields of unreadable) {
      expect(yield* Effect.catch(asBridge(other, fields), (taken) => Effect.succeed(taken)), JSON.stringify(fields).slice(0, 60))
        .toEqual(new Routes.SubmitFailed({ reason: "refused", status: 400 }))
    }
    expect(yield* seqOf(host)).toBe(3)
    // A view and no values, as a generated view's event without any sends: taken.
    expect((yield* earlier(host, Bridge.questionOwner(other), "question:" + other, sourced(other, Bridge.questionOwner(other), { source })))._tag)
      .toBe("Accepted")
  }))
})

test("what the timeline notes on a message reaches it whole, under the message's own writer and Postgres's version, a mark taken away included", async () => {
  const phase = JSON.stringify({ title: "Planning", summary: "Chose the shard.", closed: true, covered: 2 })
  const { lines, count } = await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.answered(answer("Because."))).toBe("ok")
    const note = (messageId: string, role: "user" | "assistant", version: number, notes: Bridge.Noted["notes"]): Bridge.Noted =>
      ({ conversationId: conversation, messageId, role, version, notes })
    const rows = Effect.map(messagesOf(host), (messages) =>
      rowsOf({ messages }, { conversationId: conversation }).map((row) => [row.summary, row.summaryRevision, row.phase, row.arc]))
    // A finished answer still takes its summary, and a question the phase and the arc that start at it.
    expect(yield* bridge.noted(note(answerId, "assistant", 1, { summary: "Why a shard", summaryRevision: "rev1", phase: "", arc: "" }))).toEqual({ outcome: "ok", settled: true })
    expect(yield* bridge.noted(note(questionId.toUpperCase(), "user", 1, { phase, arc: "" }))).toEqual({ outcome: "ok", settled: true })
    expect(yield* bridge.noted(note(questionId, "user", 2, { phase, arc: phase }))).toEqual({ outcome: "ok", settled: true })
    expect(yield* rows).toEqual([[null, null, phase, phase], ["Why a shard", "rev1", null, null]])
    expect((yield* messagesOf(host)).map((message) => message.noteVersion)).toEqual([2, 1])
    expect(yield* seqOf(host)).toBe(9)
    // The same write again is its key's receipt.
    expect(yield* bridge.noted(note(questionId, "user", 2, { phase, arc: phase }))).toEqual({ outcome: "ok", settled: true })
    expect(yield* seqOf(host)).toBe(9)
    // A later segmentation takes the phase away: the shard holds "", which reads as no mark.
    expect(yield* bridge.noted(note(questionId, "user", 3, { phase: "", arc: phase }))).toEqual({ outcome: "ok", settled: true })
    expect((yield* messagesOf(host))[0]).toMatchObject({ phase: "", arc: phase, noteVersion: 3 })
    expect(yield* rows).toEqual([[null, null, null, phase], ["Why a shard", "rev1", null, null]])
    // And sets it again, as it was first: a later write, under a later version.
    expect(yield* bridge.noted(note(questionId, "user", 6, { phase, arc: phase }))).toEqual({ outcome: "ok", settled: true })
    expect((yield* rows)[0]).toEqual([null, null, phase, phase])

    // Two writes the shard was never told, delivered late and out of order: each is older than the notes it holds, so
    // each is taken with no event and the newer notes stand whole, the mark the older write lacked included.
    const before = yield* messagesOf(host)
    expect(yield* bridge.noted(note(questionId, "user", 5, { phase: "", arc: "" }))).toEqual({ outcome: "ok", settled: true })
    expect(yield* bridge.noted(note(questionId, "user", 4, { summary: "An older summary", summaryRevision: "rev0", phase: "", arc: "" }))).toEqual({ outcome: "ok", settled: true })
    expect(yield* messagesOf(host)).toEqual(before)
    expect((yield* messagesOf(host))[0]).toMatchObject({ phase, arc: phase, noteVersion: 6 })
    expect((yield* host.events(conversation, (yield* seqOf(host)) - 2))).toEqual([[], []])

    // A note under the other role's writer is not the message's author's; a message the shard never held, noted with
    // no exchange to bring it, is not there yet, and takes no receipt that would say so for ever.
    expect(yield* bridge.noted(note(questionId, "assistant", 7, { summary: "Nope", summaryRevision: "rev2" }))).toEqual({ outcome: "unavailable", settled: false })
    expect(yield* bridge.noted(note("66666666-6666-4666-8666-666666666666", "assistant", 1, { summary: "Gone", summaryRevision: "rev1" })))
      .toEqual({ outcome: "unavailable", settled: false })
    // A summary or a mark the timeline could not read is refused whole.
    expect(yield* bridge.noted(note(answerId, "assistant", 7, { summary: "two\nlines", summaryRevision: "rev3" }))).toEqual({ outcome: "unavailable", settled: false })
    expect(yield* bridge.noted(note(answerId, "assistant", 7, { phase: SECRET }))).toEqual({ outcome: "unavailable", settled: false })
    // A message id that is not a UUID, a version that is not a count, or an exchange whose ids are not UUIDs, builds no
    // key: nothing is sent.
    const sequenced = yield* seqOf(host)
    expect(yield* bridge.noted(note("not-a-uuid", "assistant", 1, { summary: "x" }))).toEqual({ outcome: "unavailable", settled: false })
    for (const version of [-1, 1.5, Number.NaN, 2 ** 60]) {
      expect(yield* bridge.noted(note(answerId, "assistant", version, { summary: "x" })), String(version)).toEqual({ outcome: "unavailable", settled: false })
    }
    expect(yield* bridge.noted({ ...note(answerId, "assistant", 7, { summary: "x" }), exchange: { ...question, questionId: "q " + SECRET } })).toEqual({ outcome: "unavailable", settled: false })
    expect(yield* bridge.noted({ ...note(answerId, "assistant", 7, { summary: "x" }), exchange: { ...question, answerId: "a/b" } })).toEqual({ outcome: "unavailable", settled: false })
    expect(yield* seqOf(host)).toBe(sequenced)
    yield* Bridge.noted(note(answerId, "assistant", 8, { summary: "Unbridged", summaryRevision: "rev4" }))
    expect((yield* rows)[1]![0]).toBe("Why a shard")
    yield* Bridge.noted(note(answerId, "assistant", 8, { summary: "Bridged", summaryRevision: "rev4" }))
      .pipe(Effect.provide(MessagesShardBridge.layer(host.forward)))
    expect((yield* rows)[1]).toEqual(["Bridged", "rev4", null, null])
  }))
  expect(count("noted", "ok")).toBe(9)
  expect(lines()).toEqual([
    { write: "noted", conversationId: conversation, outcome: "unavailable", reason: "refused", status: 403, refusal: "author", settled: false },
    { write: "noted", conversationId: conversation, outcome: "unavailable", reason: "refused", status: 403, refusal: "missing", settled: false },
    { write: "noted", conversationId: conversation, outcome: "unavailable", reason: "refused", status: 400, settled: false },
    { write: "noted", conversationId: conversation, outcome: "unavailable", reason: "refused", status: 400, settled: false },
    ...Array.from({ length: 7 }, () => ({ write: "noted", conversationId: conversation, outcome: "unavailable", reason: "invalid_target", settled: false })),
  ])
})

test("a note that arrives before its message brings the message: its exchange is posted first, pending or finished", async () => {
  const { lines, count } = await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    const summary = { summary: "Why a shard", summaryRevision: "rev1", phase: "", arc: "" }
    // The timeline's note on an answer the shard has never heard of, with what Postgres holds of its exchange: the
    // question, the answer and its end are posted under the keys `asked` and `answered` use, and then the note lands.
    const noted: Bridge.Noted = {
      conversationId: conversation.toUpperCase(),
      messageId: answerId.toUpperCase(),
      role: "assistant",
      version: 1,
      notes: summary,
      exchange: { ...answer("Because."), questionId: questionId.toUpperCase(), answerId: answerId.toUpperCase() },
    }
    expect(yield* bridge.noted(noted)).toEqual({ outcome: "ok", settled: true })
    expect(yield* messagesOf(host)).toEqual([QUESTION_ROW, { ...ANSWERED_ROW, ...summary, noteVersion: 1 }])
    expect(yield* seqOf(host)).toBe(7)
    // The answer's own bridge, arriving after the note: every command is its key's receipt, and nothing moves.
    expect(yield* bridge.asked(question)).toBe("ok")
    expect(yield* bridge.answered(answer("Because."))).toBe("ok")
    expect(yield* seqOf(host)).toBe(7)
    expect(yield* messagesOf(host)).toEqual([QUESTION_ROW, { ...ANSWERED_ROW, ...summary, noteVersion: 1 }])

    // A question noted while its answer is still pending: the pair is posted as `asked` posts it, and the question
    // takes the phase that starts at it. Its answer then lands as ever.
    const second: Bridge.Asked = {
      conversationId: conversation,
      questionId: "33333333-3333-4333-8333-333333333333",
      answerId: "44444444-4444-4444-8444-444444444444",
      question: { text: "And then?", position: 42, createdAt: ANSWERED_AT },
      answer: { position: 43, createdAt: ANSWERED_AT },
    }
    const phase = JSON.stringify({ title: "Planning", summary: "Chose the shard.", closed: false, covered: 1 })
    expect(yield* bridge.noted({
      conversationId: conversation, messageId: second.questionId, role: "user", version: 1, notes: { phase, arc: "" }, exchange: second,
    })).toEqual({ outcome: "ok", settled: true })
    expect((yield* messagesOf(host)).slice(2)).toMatchObject([
      { id: second.questionId, author: Bridge.questionOwner(second.questionId), role: "user", position: 42, phase, noteVersion: 1 },
      { id: second.answerId, author: Bridge.answerOwner(second.answerId), status: "streaming", position: 43 },
    ])
    expect(yield* bridge.answered({ ...second, text: "Then this.", updatedAt: ANSWERED_AT })).toBe("ok")
    expect((yield* messagesOf(host))[3]).toMatchObject({ body: "Then this.", status: "complete" })
    // The note alone, for a question the shard does not hold and with nothing to bring it, is not taken and leaves no
    // receipt: the shard is not yet able to take it, which is no decision against it.
    const lone: Bridge.Lone = {
      conversationId: conversation,
      questionId: "66666666-6666-4666-8666-666666666666",
      question: { text: "Asked, and never answered", position: 60, createdAt: ASKED_AT },
    }
    const alone = { conversationId: conversation, messageId: lone.questionId, role: "user" as const, version: 1, notes: summary }
    const before = yield* seqOf(host)
    expect(yield* bridge.noted(alone)).toEqual({ outcome: "unavailable", settled: false })
    expect(yield* seqOf(host)).toBe(before)
    // The same note, under the same key, once it comes with the question Postgres holds, which has no answer beside
    // it: the question itself is posted, at its place, and the note lands on it.
    expect(yield* bridge.noted({ ...alone, exchange: { ...lone, questionId: lone.questionId.toUpperCase() } })).toEqual({ outcome: "ok", settled: true })
    expect((yield* messagesOf(host)).at(-1)).toMatchObject({
      id: lone.questionId, author: Bridge.questionOwner(lone.questionId), role: "user", body: "Asked, and never answered",
      status: "posted", position: 60, createdAt: ASKED_AT, summary: "Why a shard", noteVersion: 1,
    })
    expect(yield* seqOf(host)).toBe(before + 2)
    // An exchange whose answer failed is posted as it ended: what the answer had said, why it failed and when, under
    // a status that ended. It is never an empty answer still streaming.
    const failing = {
      ...second,
      questionId: "77777777-7777-4777-8777-777777777777",
      answerId: "88888888-8888-4888-8888-888888888888",
      question: { text: "Asked of a model that broke", position: 70, createdAt: ASKED_AT },
      answer: { position: 71, createdAt: ASKED_AT },
    }
    const failed: Bridge.Answered = { ...failing, text: "Half an ans", updatedAt: ANSWERED_AT, failure: "model_error" }
    expect(yield* bridge.noted({
      conversationId: conversation, messageId: failing.answerId, role: "assistant", version: 1, notes: summary, exchange: failed,
    })).toEqual({ outcome: "ok", settled: true })
    expect((yield* messagesOf(host)).slice(-2)).toMatchObject([
      { id: failing.questionId, role: "user", status: "posted", position: 70 },
      {
        id: failing.answerId, role: "assistant", body: "Half an ans", status: "failed", failure: "model_error",
        updatedAt: ANSWERED_AT, position: 71, summary: "Why a shard", noteVersion: 1,
      },
    ])
    // Given again, by its note or as the answer itself, it is every key's receipt: nothing is added or refused.
    const ended = yield* seqOf(host)
    expect(yield* bridge.answered(failed)).toBe("ok")
    expect(yield* seqOf(host)).toBe(ended)
    expect(Bridge.isAsked(lone)).toBe(false)
    expect([Bridge.isAsked(failing), Bridge.isAnswered(failing), Bridge.isAnswered(failed)]).toEqual([true, false, true])
  }))
  expect(count("noted", "ok")).toBe(4)
  expect(lines()).toEqual([
    { write: "noted", conversationId: conversation, outcome: "unavailable", reason: "refused", status: 403, refusal: "missing", settled: false },
  ])
})

/**
 * A shard that answers the commands `decide` gives an answer for, as the protocol answers one or with a bare status,
 * and is the real one for every other. Every command id it is sent is kept in `sent`.
 */
const answering = (
  host: ShardHost,
  decide: (id: string, submit: ShardProtocol.SubmitRequest) => Record<string, unknown> | number | undefined,
) => {
  const sent: Array<string> = []
  const forward: Routes.Forward = (id, request) =>
    Effect.gen(function*() {
      const text = yield* Effect.orDie(request.text)
      const submit = decodeSubmit(text)
      sent.push(submit.command.key[1])
      const answer = decide(submit.command.key[1], submit)
      if (typeof answer === "number") return HttpServerResponse.empty({ status: answer })
      if (answer !== undefined) return HttpServerResponse.jsonUnsafe({ key: submit.command.key, shard: id, ...answer })
      return yield* host.forward(id, HttpServerRequest.fromWeb(new Request("https://messages.internal/api/messages/submit", {
        method: "POST",
        headers: request.headers,
        body: text,
      })))
    })
  return { sent, bridge: MessagesShardBridge.make(forward) }
}

test("an answer that ended is bridged with what its run wrote, before the status that freezes it: its steps, its model, why it stopped and its token counts", async () => {
  await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    const run = {
      parts: [
        { id: "step-1", kind: "step", flow: "repo/read", status: "done" },
        { id: "step-2", kind: "step", flow: "repo/search", status: "failed" },
      ],
      modelId: "fable-5-2",
      stopReason: "error",
      inputTokens: 1200,
      outputTokens: 0,
    } as const
    expect(yield* bridge.answered({ ...answer("Half an ans"), failure: "model_error", run })).toBe("ok")
    const [, failed] = yield* messagesOf(host)
    expect(failed).toEqual({ ...ANSWER_ROW, body: "Half an ans", status: "failed", failure: "model_error", updatedAt: ANSWERED_AT, ...run })
    // The row a page reads off the shard shows the steps and the usage Electric shows of Postgres.
    const [, row] = rowsOf({ messages: yield* messagesOf(host) }, { conversationId: conversation })
    expect(row).toMatchObject({ status: "failed", failure: "model_error", parts: run.parts, modelId: "fable-5-2", stopReason: "error", inputTokens: 1200, outputTokens: 0 })
    // The same answer again is every key's receipt.
    const head = yield* seqOf(host)
    expect(yield* bridge.answered({ ...answer("Half an ans"), failure: "model_error", run })).toBe("ok")
    expect(yield* seqOf(host)).toBe(head)
  }))
})

test("a run Postgres holds partly outside the reducer's bounds is bridged with every field inside them, before the status that freezes it", async () => {
  await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    const steps = Array.from({ length: 70 }, (_, index) => ({ id: `step-${index}`, kind: "step", flow: "repo/read", status: "done" }))
    // As Postgres holds an answer stored before the bounds were: a model name too long, and more steps than are recorded.
    const run = Source.runOf({ parts: steps, modelId: "m".repeat(300), stopReason: "error", inputTokens: 1200, outputTokens: 0 })
    expect(run).toEqual({ parts: steps.slice(0, 64), stopReason: "error", inputTokens: 1200, outputTokens: 0 })
    expect(yield* bridge.answered({ ...answer("Half an ans"), failure: "model_error", run })).toBe("ok")
    const [, failed] = yield* messagesOf(host)
    expect(failed).toEqual({ ...ANSWER_ROW, body: "Half an ans", status: "failed", failure: "model_error", updatedAt: ANSWERED_AT, ...run })
    expect(failed).not.toHaveProperty("modelId")
    // Each field stands or falls alone, and steps are kept up to the first the reducer takes none of.
    expect(Source.runOf({ modelId: "fable-5-2", stopReason: "s".repeat(300), inputTokens: -1, outputTokens: 2.5 })).toEqual({ modelId: "fable-5-2" })
    expect(Source.runOf({ parts: [steps[0], { id: "x", kind: "leap", flow: "repo/read", status: "done" }, steps[2]], inputTokens: 3 }))
      .toEqual({ parts: [steps[0]], inputTokens: 3 })
    expect(Source.runOf({ parts: "none", modelId: 7 })).toEqual({})
  }))
})

test("an answer longer than a body update carries is bridged cut at a whole character, and ends: finished or failed, never left streaming", async () => {
  const { lines, count } = await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    // Past the bound three ways: a pair of surrogates across it, a pair ending on it, and no pair near it.
    const texts = [
      `${"a".repeat(MAX_BODY_LENGTH - 1)}${"😀".repeat(400)}`,
      `${"a".repeat(MAX_BODY_LENGTH - 2)}${"😀".repeat(400)}`,
      "界".repeat(MAX_BODY_LENGTH + 400),
    ]
    const kept = [MAX_BODY_LENGTH - 1, MAX_BODY_LENGTH, MAX_BODY_LENGTH]
    for (const [index, text] of texts.entries()) {
      const ids = {
        conversationId: conversation,
        questionId: `1111111${index}-1111-4111-8111-111111111111`,
        answerId: `2222222${index}-2222-4222-8222-222222222222`,
      }
      expect(text.length).toBeGreaterThan(MAX_BODY_LENGTH)
      expect(Bridge.bodyWithin(text).length).toBe(kept[index])
      const asked = { ...question, ...ids, question: { ...question.question, text: "Why?" } }
      // Never bridged while it streamed, as an answer stored before the shard: the pair, its body and its end at once.
      // The last one failed, with what its run wrote.
      const ended: Bridge.Answered = index < 2
        ? { ...asked, text, updatedAt: ANSWERED_AT }
        : { ...asked, text, updatedAt: ANSWERED_AT, failure: "model_error", run: { modelId: "fable-5-2", outputTokens: 9 } }
      expect(yield* bridge.answered(ended)).toBe("ok")
      const stored = (yield* messagesOf(host)).find((message) => message.id === ids.answerId)!
      expect(stored.status).toBe(index < 2 ? "complete" : "failed")
      expect(stored.body === text.slice(0, kept[index])).toBe(true)
      expect(stored.body.isWellFormed()).toBe(true)
      if (index === 2) expect(stored).toMatchObject({ failure: "model_error", modelId: "fable-5-2", outputTokens: 9, updatedAt: ANSWERED_AT })
      // The same answer read again is every key's receipt: nothing is added, and nothing refused for a status that ended.
      const head = yield* seqOf(host)
      expect(yield* bridge.answered(ended)).toBe("ok")
      expect(yield* seqOf(host)).toBe(head)
    }
    // A text within the bound is carried as it is.
    expect(Bridge.bodyWithin("Because.")).toBe("Because.")
  }))
  expect(count("answered", "ok")).toBe(6)
  expect(lines()).toEqual([])
})

test("a note is settled by the shard's answer to its own command, and by nothing posted before it", async () => {
  const summary = { summary: "Why a shard", summaryRevision: "rev1", phase: "", arc: "" }
  const noted = (version: number, exchange: Bridge.Exchange = answer("Because.")): Bridge.Noted =>
    ({ conversationId: conversation, messageId: answerId, role: "assistant", version, notes: { ...summary, summary: `Summary ${version}` }, exchange })
  const noteKey = (version: number) => `noted:${answerId}:${version}`
  const { lines } = await observed((host) => Effect.gen(function*() {
    const real = MessagesShardBridge.make(host.forward)
    const held = Effect.map(messagesOf(host), (messages) => [messages[1]?.summary, messages[1]?.noteVersion])
    expect(yield* real.answered(answer("Because."))).toBe("ok")

    // The shard is asked nothing more once a command posted before the note cannot be delivered: no note, no settling.
    const lost = answering(host, (id) => (id.startsWith("question:") ? 503 : undefined))
    expect(yield* lost.bridge.noted(noted(1))).toEqual({ outcome: "unavailable", settled: false })
    expect(lost.sent).toEqual([`question:${questionId}`])
    expect(yield* held).toEqual([undefined, undefined])

    // A command posted before the note that the shard decides against, by a receipt or by a conflict, is no answer
    // to the note. The note is still sent, and a shard that cannot be reached for it leaves it unsettled.
    for (const [decision, outcome] of [
      [{ _tag: "Refused", reason: "terminal_metadata" }, "unavailable"],
      [{ _tag: "IdempotencyConflict", position: null }, "unavailable"],
    ] as const) {
      const declined = answering(host, (id) => (id.startsWith("updated:") ? decision : id.startsWith("noted:") ? 503 : undefined))
      expect(yield* declined.bridge.noted(noted(1))).toEqual({ outcome, settled: false })
      // What followed the declined command among the exchange's own was skipped: the note came next.
      expect(declined.sent.slice(-2)).toEqual([`updated:${answerId}:${ANSWERED_AT}`, noteKey(1)])
    }
    expect(yield* held).toEqual([undefined, undefined])

    // The same refusals with the note's own command answered: it settles, and the write still says what was declined.
    const refusedBefore = answering(host, (id) => (id.startsWith("updated:") ? { _tag: "Refused", reason: "terminal_metadata" } : undefined))
    expect(yield* refusedBefore.bridge.noted(noted(1))).toEqual({ outcome: "refused", settled: true })
    expect(yield* held).toEqual(["Summary 1", 1])
    const conflictBefore = answering(host, (id) => (id.startsWith("streaming:") ? { _tag: "IdempotencyConflict", position: null } : undefined))
    expect(yield* conflictBefore.bridge.noted(noted(2))).toEqual({ outcome: "idempotency_conflict", settled: true })
    expect(yield* held).toEqual(["Summary 2", 2])
    // With no fault at all: Postgres wrote the row again after it ended, so the exchange's last write is one the
    // shard, which holds the answer ended, refuses. The message stands, and its note lands on it.
    const later = { ...answer("Because."), updatedAt: "2026-11-25 10:09:00+00", run: { modelId: "fable-5-2" } }
    expect(yield* real.noted(noted(3, later))).toEqual({ outcome: "refused", settled: true })
    expect(yield* held).toEqual(["Summary 3", 3])
    expect((yield* messagesOf(host))[1]).toMatchObject({ status: "complete", updatedAt: ANSWERED_AT })
    expect((yield* messagesOf(host))[1]).not.toHaveProperty("modelId")

    // The note's own command, when the shard does not sequence it, settles nothing: a conflict, a refusal, an epoch
    // that keeps moving.
    const head = yield* seqOf(host)
    const conflicting = answering(host, (id) => (id.startsWith("noted:") ? { _tag: "IdempotencyConflict", position: null } : undefined))
    expect(yield* conflicting.bridge.noted(noted(4))).toEqual({ outcome: "idempotency_conflict", settled: false })
    const refusing = answering(host, (id) => (id.startsWith("noted:") ? { _tag: "Refused", reason: "terminal_metadata" } : undefined))
    expect(yield* refusing.bridge.noted(noted(4))).toEqual({ outcome: "refused", settled: false })
    expect(refusing.sent.at(-1)).toBe(noteKey(4))
    const moving = answering(host, (id, submit) => (id.startsWith("noted:") ? { _tag: "StaleEpoch", epoch: submit.epoch + 1 } : undefined))
    expect(yield* moving.bridge.noted(noted(4))).toEqual({ outcome: "stale_epoch", settled: false })
    expect(moving.sent.slice(-2)).toEqual([noteKey(4), noteKey(4)])
    expect(yield* seqOf(host)).toBe(head)
    expect(yield* held).toEqual(["Summary 3", 3])

    // A receipt that says the note's message was missing, kept before the shard refused such a note without one: it
    // answers the note's key for ever. The message is there now, so the note is sent under a key that receipt does
    // not hold, and that answer settles it.
    const stale = answering(host, (id) => (id === noteKey(4) ? { _tag: "Refused", reason: "message_missing" } : undefined))
    expect(yield* stale.bridge.noted(noted(4))).toEqual({ outcome: "ok", settled: true })
    expect(stale.sent.slice(-2)).toEqual([noteKey(4), `${noteKey(4)}:again`])
    expect(yield* held).toEqual(["Summary 4", 4])
    expect(yield* seqOf(host)).toBe(head + 1)
    // Sent again, the second key is its own receipt: settled, and nothing is added.
    expect(yield* stale.bridge.noted(noted(4))).toEqual({ outcome: "ok", settled: true })
    expect(yield* seqOf(host)).toBe(head + 1)
    // And a shard that still says the message is missing under the second key settles nothing.
    const missing = answering(host, (id) => (id.startsWith("noted:") ? { _tag: "Refused", reason: "message_missing" } : undefined))
    expect(yield* missing.bridge.noted(noted(5))).toEqual({ outcome: "refused", settled: false })
    expect(missing.sent.slice(-2)).toEqual([noteKey(5), `${noteKey(5)}:again`])
    expect(yield* held).toEqual(["Summary 4", 4])
  }))
  const line = (said: Record<string, unknown>) => ({ write: "noted", conversationId: conversation, ...said })
  expect(lines()).toEqual([
    line({ outcome: "unavailable", reason: "refused", status: 503, settled: false }),
    line({ outcome: "unavailable", reason: "refused", status: 503, settled: false }),
    line({ outcome: "unavailable", reason: "refused", status: 503, settled: false }),
    line({ outcome: "refused", step: "UpdateMessageMetadata", reason: "terminal_metadata", settled: true }),
    line({ outcome: "idempotency_conflict", step: "UpdateMessageStatus", settled: true }),
    line({ outcome: "refused", step: "UpdateMessageMetadata", reason: "terminal_metadata", settled: true }),
    line({ outcome: "idempotency_conflict", step: "UpdateMessageMetadata", settled: false }),
    line({ outcome: "refused", step: "UpdateMessageMetadata", reason: "terminal_metadata", settled: false }),
    line({ outcome: "stale_epoch", step: "UpdateMessageMetadata", settled: false }),
    line({ outcome: "refused", step: "UpdateMessageMetadata", reason: "message_missing", settled: false }),
  ])
})

test("what the bridge wrote is held to the shard's rules: nobody else extends the answer or rewrites the question", async () => {
  await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(question)).toBe("ok")
    const extend = (messageId: string, author: string) => ({ _tag: "UpdateMessageBody", messageId, author, body: SECRET + " more" })
    const ceiling = [[Messages.readCapability(shard), Messages.writeCapability(shard)]]
    const agent: Actor = { ...ada, act: { kind: "agent", id: "run-1", ceiling } }
    const RUN = yield* Effect.promise(() => ownerIn(conversation, agent))
    const tries: ReadonlyArray<readonly [Actor, readonly [string, string], unknown, string]> = [
      // The person's page: the question ChatApi wrote for them, and the answer written for it.
      [ada, [ADA + "/laptop", "1"], extend(questionId, ADA), "author"],
      [ada, [ADA + "/laptop", "2"], extend(answerId, ADA), "author"],
      // Claiming the question's or the answer's author, or the bridge's node under either.
      [ada, [ADA + "/laptop", "3"], extend(answerId, ANSWER), "author"],
      [ada, [ADA + "/laptop", "5"], extend(questionId, QUESTION), "author"],
      [ada, [ANSWER + "/" + Bridge.BRIDGE_DEVICE, "4"], extend(answerId, ANSWER), "origin"],
      [ada, [QUESTION + "/" + Bridge.BRIDGE_DEVICE, "6"], extend(questionId, QUESTION), "origin"],
      // The person's own run: the question under any name, the answer, and the answer under the bridge's name.
      [agent, [RUN, "1"], extend(questionId, RUN), "person_only"],
      [agent, [RUN, "5"], extend(questionId, QUESTION), "person_only"],
      [agent, [RUN, "6"], extend(questionId, ANSWER), "person_only"],
      [agent, [RUN, "2"], extend(answerId, RUN), "author"],
      [agent, [RUN, "3"], extend(answerId, ANSWER), "author"],
      [agent, [RUN, "4"], { _tag: "UpdateMessageStatus", messageId: answerId, status: "failed" }, "author"],
      // Another person.
      [bob, [BOB, "1"], extend(answerId, ANSWER), "author"],
      [bob, [BOB, "2"], extend(questionId, QUESTION), "author"],
    ]
    for (const [actor, key, payload, refusal] of tries) {
      expect(yield* Effect.promise(() => submitAs(host, actor, key, payload)), refusal).toMatchObject({ status: 403, refusal })
    }
    expect(yield* seqOf(host)).toBe(3)
    expect((yield* messagesOf(host)).map((message) => message.body)).toEqual([SECRET, ""])
  }))
})

test("a write the shard does not take is a log line and a count, never a failure, and never carries what was written", async () => {
  const refuse = (status: number, refusal?: string): Routes.Forward => () =>
    Effect.succeed(HttpServerResponse.empty({ status, ...(refusal === undefined ? {} : { headers: { [Routes.refusalHeader]: refusal } }) }))
  const { logs, lines, count } = await observed((host) => Effect.gen(function*() {
    const failing: Routes.Forward<Error> = () => Effect.fail(new Error(SECRET))
    expect(yield* MessagesShardBridge.make(failing).asked(question)).toBe("unavailable")
    expect(yield* MessagesShardBridge.make(refuse(403, "person_only")).asked(question)).toBe("unavailable")
    expect(yield* MessagesShardBridge.make(refuse(503)).answered(answer(SECRET))).toBe("unavailable")
    // Text an answer held where a code belongs: a refusal header, and a reducer's reason. Neither reaches a log line.
    expect(yield* MessagesShardBridge.make(refuse(403, SECRET)).asked(question)).toBe("unavailable")
    const reasoning: Routes.Forward = (id, request) =>
      Effect.map(Effect.orDie(request.text), (text) =>
        HttpServerResponse.jsonUnsafe({ _tag: "Refused", key: decodeSubmit(text).command.key, shard: id, reason: SECRET }))
    expect(yield* MessagesShardBridge.make(reasoning).asked(question)).toBe("refused")
    // An answer for another command is no answer.
    const misnaming: Routes.Forward = (id) =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ _tag: "Accepted", key: [ADA, "1"], position: { shard: id, epoch: 0, seq: 1 } }))
    expect(yield* MessagesShardBridge.make(misnaming).asked(question)).toBe("unavailable")
    expect(yield* MessagesShardBridge.make(() => Effect.never, { within: "20 millis" }).asked(question)).toBe("timeout")
    // An id that is not a UUID names no shard: nothing is sent.
    const sent: Array<string> = []
    const counting: Routes.Forward = (id, request) => {
      sent.push(id)
      return host.forward(id, request)
    }
    const bridge = MessagesShardBridge.make(counting)
    expect(yield* bridge.asked({ ...question, conversationId: "conv/../elsewhere " + SECRET })).toBe("unavailable")
    expect(yield* bridge.answered({ ...answer(SECRET), answerId: "a:b/c" })).toBe("unavailable")
    expect(yield* bridge.asked({ ...question, questionId: "q " + SECRET })).toBe("unavailable")
    expect(sent).toEqual([])
    expect(yield* seqOf(host)).toBe(0)

    // The question's id is nobody else's to take, stored or not: a page's post under it is refused, with nothing sequenced.
    const taken = yield* Effect.promise(() =>
      submitAs(host, asker, [ASKER + "/laptop", "1"], { _tag: "PostMessage", messageId: questionId, author: ASKER, body: "another", role: "user" }))
    expect(taken).toMatchObject({ status: 403, refusal: "reserved" })
    expect(yield* seqOf(host)).toBe(0)
    // One id for a question and its answer: the reducer refuses the second post, and the bridge stops there.
    expect(yield* bridge.asked({ ...question, answerId: questionId })).toBe("refused")
    expect(sent).toEqual([shard, shard])
    expect(yield* seqOf(host)).toBe(1)
  }))
  expect(lines()).toEqual([
    { write: "asked", conversationId: conversation, outcome: "unavailable", reason: "unreachable" },
    { write: "asked", conversationId: conversation, outcome: "unavailable", reason: "refused", status: 403, refusal: "person_only" },
    { write: "answered", conversationId: conversation, outcome: "unavailable", reason: "refused", status: 503 },
    { write: "asked", conversationId: conversation, outcome: "unavailable", reason: "refused", status: 403, refusal: "other" },
    { write: "asked", conversationId: conversation, outcome: "refused", step: "PostMessage", reason: "other" },
    { write: "asked", conversationId: conversation, outcome: "unavailable", reason: "invalid_response", status: 200 },
    { write: "asked", conversationId: conversation, outcome: "timeout" },
    // A conversation id that is not a UUID is whatever its caller held: the line leaves it out.
    { write: "asked", outcome: "unavailable", reason: "invalid_target" },
    { write: "answered", conversationId: conversation, outcome: "unavailable", reason: "invalid_target" },
    { write: "asked", conversationId: conversation, outcome: "unavailable", reason: "invalid_target" },
    { write: "asked", conversationId: conversation, outcome: "refused", step: "PostMessage", reason: "message_conflict" },
  ])
  expect(logs.filter((log) => log.message === "chat.shard.bridge").every((log) => log.level === "WARN")).toBe(true)
  expect(JSON.stringify(logs)).not.toContain(SECRET)
  // Nor who asked: not their id, which no span id can spell by chance, and not the owner name they were admitted under.
  expect(JSON.stringify(logs)).not.toContain("sentinel")
  expect(JSON.stringify(logs)).not.toContain(ASKER)
  expect([count("asked", "unavailable"), count("answered", "unavailable"), count("asked", "timeout"), count("asked", "refused")])
    .toEqual([6, 2, 1, 2])
})

test("a shard on a later epoch is written under the epoch it names, once", async () => {
  const { lines } = await observed((host) => Effect.gen(function*() {
    // A shard whose epoch is `at`: a submit under another is answered `StaleEpoch`, as the protocol answers one.
    const epochs: Array<number> = []
    const onEpoch = (at: number | "never"): Routes.Forward => (id, request) =>
      Effect.gen(function*() {
        const submit = decodeSubmit(yield* Effect.orDie(request.text))
        epochs.push(submit.epoch)
        if (submit.epoch !== at) {
          return HttpServerResponse.jsonUnsafe({
            _tag: "StaleEpoch",
            key: submit.command.key,
            shard: id,
            epoch: at === "never" ? submit.epoch + 1 : at,
          })
        }
        return yield* host.forward(id, HttpServerRequest.fromWeb(new Request("https://messages.internal/api/messages/submit", {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({ ...submit, epoch: 0 }),
        })))
      })
    expect(yield* MessagesShardBridge.make(onEpoch(3)).asked(question)).toBe("ok")
    // The first command learns the epoch; the ones after it are sent under it.
    expect(epochs).toEqual([0, 3, 3, 3])
    expect(yield* seqOf(host)).toBe(3)
    // An epoch that moves under every submit: given up on, with nothing more written.
    expect(yield* MessagesShardBridge.make(onEpoch("never")).answered(answer("Because."))).toBe("stale_epoch")
    expect(yield* seqOf(host)).toBe(3)
  }))
  expect(lines()).toEqual([{ write: "answered", conversationId: conversation, outcome: "stale_epoch", step: "PostMessage" }])
})

test("where no bridge is provided a write does nothing; where one is, it is the shard's", async () => {
  await observed((host) => Effect.gen(function*() {
    yield* Bridge.asked(question)
    yield* Bridge.answered(answer("Because."))
    expect(yield* seqOf(host)).toBe(0)
    yield* Effect.gen(function*() {
      yield* Bridge.asked(question)
      yield* Bridge.answered(answer("Because."))
    }).pipe(Effect.provide(MessagesShardBridge.layer(host.forward)))
    expect((yield* messagesOf(host)).map((message) => [message.id, message.body, message.status])).toEqual([
      [questionId, SECRET, "posted"],
      [answerId, "Because.", "complete"],
    ])
  }))
})

test("nothing the bridge replicates says who asked: a second reader's Pull and Snapshot hold message ids and nothing of a person", async () => {
  await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(question)).toBe("ok")
    expect(yield* bridge.answered(answer("Because."))).toBe("ok")
    const read = (path: string) =>
      Effect.promise(async () => {
        const response = await host.fetchAs(bob)(`https://smithers.example/api/conversations/${conversation}/messages/${path}`)
        expect(response.status).toBe(200)
        return await response.text()
      })
    // Every key and author another reader is sent, as Pull sends the journal.
    const pulled = yield* read("pull?" + ShardProtocol.pullQuery({ version: 2, shard, epoch: 0, after: 0, limit: 256 }))
    const page = JSON.parse(pulled) as { readonly entries: ReadonlyArray<{ readonly key: readonly [string, string]; readonly events: ReadonlyArray<{ readonly author?: string }> }> }
    expect(page.entries.map((entry) => entry.key)).toEqual([
      [QUESTION + "/chatapi", "question:" + questionId],
      [ANSWER + "/chatapi", "answer:" + answerId],
      [ANSWER + "/chatapi", "streaming:" + answerId],
      [ANSWER + "/chatapi", "body:" + answerId + ":8"],
      [ANSWER + "/chatapi", "updated:" + answerId + ":" + ANSWERED_AT],
      [ANSWER + "/chatapi", "complete:" + answerId],
    ])
    expect(page.entries.flatMap((entry) => entry.events.flatMap((event) => event.author ?? []))).toEqual([QUESTION, ANSWER])
    // And as Snapshot sends the folded state, once the journal is compacted into it.
    yield* host.compact(conversation)
    const snapshot = yield* read("snapshot?" + new URLSearchParams({ shard }))
    const folded = JSON.parse(snapshot) as { readonly state: { readonly chat: { readonly messages: ReadonlyArray<{ readonly author: string }> } } }
    expect(folded.state.chat.messages.map((message) => message.author)).toEqual([QUESTION, ANSWER])
    // The owner names are made of the message's own id and fixed words: there is nowhere for a person's id to be.
    expect([QUESTION, ANSWER]).toEqual(["person:question:" + questionId, "answer:" + answerId])
    for (const wire of [pulled, snapshot]) {
      const withoutKnown = wire.replaceAll(questionId, "").replaceAll(answerId, "").replaceAll(conversation, "").replaceAll(SECRET, "")
      expect(withoutKnown).not.toMatch(/person:(?!question:)/)
      expect(withoutKnown).not.toContain(ADA)
    }
    // No signed-in person or run is ever admitted under a bridge owner: a person's owner name has no second colon.
    for (const id of ["question:" + questionId, "question", questionId, "a:b"]) {
      const owner = yield* Routes.personOwner(OWNER_SECRET, conversation, id)
      expect(owner).not.toBe(QUESTION)
      expect(owner.split(":")).toHaveLength(2)
    }
  }))
})

test("ChatApi's ids are its bridge's before it stores them and while its bridge is late: two other writers cannot take one, and the bridge then lands", async () => {
  const { lines } = await observed((host) => Effect.gen(function*() {
    // Another person, and the asker's own run, each allowed to write here, each posting under ChatApi's ids.
    const ceiling = [[Messages.readCapability(shard), Messages.writeCapability(shard)]]
    const agent: Actor = { ...ada, act: { kind: "agent", id: "run-1", ceiling } }
    const RUN = yield* Effect.promise(() => ownerIn(conversation, agent))
    const squats: ReadonlyArray<readonly [Actor, readonly [string, string], unknown]> = [
      [bob, [BOB + "/phone", "1"], { _tag: "PostMessage", messageId: questionId, author: BOB, body: "mine now", role: "user" }],
      [bob, [BOB + "/phone", "2"], { _tag: "PostMessage", messageId: answerId, author: BOB, body: "mine now" }],
      [agent, [RUN, "1"], { _tag: "PostMessage", messageId: answerId, author: RUN, body: "", role: "assistant", questionId }],
      [agent, [RUN, "2"], { _tag: "PostMessage", messageId: questionId, author: RUN, body: "mine now" }],
    ]
    const refusedAll = Effect.gen(function*() {
      for (const [actor, key, payload] of squats) {
        expect(yield* Effect.promise(() => submitAs(host, actor, key, payload))).toMatchObject({ status: 403, refusal: "reserved" })
      }
      expect(yield* seqOf(host)).toBe(0)
    })
    // Before ChatApi has stored anything: the ids are nobody's yet, and already not theirs. The shard decides it alone.
    yield* refusedAll
    // ChatApi stored the question and its pending answer; the write into the shard never arrived. Nothing changed.
    expect(yield* MessagesShardBridge.make(() => Effect.never, { within: "20 millis" }).asked(question)).toBe("timeout")
    yield* refusedAll
    // A bridge writer posts its own message and no other: the answer's writer never posts the question.
    expect(yield* Effect.flip(Routes.submitAs(host.forward, { author: ANSWER }, {
      version: 2,
      shard,
      epoch: 0,
      command: {
        key: [ANSWER + "/" + Bridge.BRIDGE_DEVICE, "question:" + questionId],
        stream: Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard),
        payload: { _tag: "PostMessage", messageId: questionId, author: ANSWER, body: "mine now" },
      },
    }))).toEqual(new Routes.SubmitFailed({ reason: "refused", status: 403, refusal: "reserved" }))
    expect(yield* seqOf(host)).toBe(0)

    // The bridge, late: the ask sent again, then the answer. Both land whole, under the bridge's own names.
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(question)).toBe("ok")
    expect(yield* bridge.answered(answer("Because."))).toBe("ok")
    expect(yield* messagesOf(host)).toEqual([QUESTION_ROW, ANSWERED_ROW])
    // Refused the same way once bridged, as is an id ChatApi never stored: the answer says nothing of which ids exist.
    expect(yield* Effect.promise(() => submitAs(host, bob, [BOB + "/phone", "3"], squats[0]![2]))).toMatchObject({ status: 403, refusal: "reserved" })
    const never = { _tag: "PostMessage", messageId: "33333333-3333-4333-8333-333333333333", author: BOB, body: "my own" }
    expect(yield* Effect.promise(() => submitAs(host, bob, [BOB + "/phone", "4"], never))).toMatchObject({ status: 403, refusal: "reserved" })
    // The same people still write messages of their own, under ids spelled as no ChatApi message is.
    const own = { ...never, messageId: "bob-1" }
    expect((yield* Effect.promise(() => submitAs(host, bob, [BOB + "/phone", "5"], own))).answer).toMatchObject({ _tag: "Accepted" })
  }))
  expect(lines()).toEqual([{ write: "asked", conversationId: conversation, outcome: "timeout" }])
})

test("a conflict that places the command in another shard is no answer, and is not reported as a conflict", async () => {
  const elsewhere = Messages.shardOf("9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d")
  const { lines, count } = await observed((host) => Effect.gen(function*() {
    const conflicting = (position: (id: ShardProtocol.ShardId) => unknown): Routes.Forward => (id, request) =>
      Effect.map(Effect.orDie(request.text), (text) =>
        HttpServerResponse.jsonUnsafe({
          _tag: "IdempotencyConflict",
          key: decodeSubmit(text).command.key,
          shard: id,
          position: position(id),
        }))
    // A conflict with no position, and one placed in this shard, are the shard's own answer. A post's conflict is a
    // message an earlier bridge wrote, which stands; the status after it has no such reading.
    expect(yield* MessagesShardBridge.make(conflicting(() => null)).asked(question)).toBe("idempotency_conflict")
    expect(yield* MessagesShardBridge.make(conflicting((id) => ({ shard: id, epoch: 0, seq: 1 }))).asked(question))
      .toBe("idempotency_conflict")
    // One placed in another shard names this shard and contradicts itself: malformed, as the SDK's client reads it.
    expect(yield* MessagesShardBridge.make(conflicting(() => ({ shard: elsewhere, epoch: 0, seq: 1 }))).asked(question))
      .toBe("unavailable")
    expect(yield* seqOf(host)).toBe(0)
  }))
  expect(lines()).toEqual([
    { write: "asked", conversationId: conversation, outcome: "idempotency_conflict", step: "UpdateMessageStatus" },
    { write: "asked", conversationId: conversation, outcome: "idempotency_conflict", step: "UpdateMessageStatus" },
    { write: "asked", conversationId: conversation, outcome: "unavailable", reason: "invalid_response", status: 200 },
  ])
  expect([count("asked", "idempotency_conflict"), count("asked", "unavailable")]).toEqual([2, 1])
})

test("an answer at the bound in multibyte text is bridged whole, and again on a retry", async () => {
  const { lines, count } = await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    const texts = ["界".repeat(MAX_BODY_LENGTH), "\u0001".repeat(MAX_BODY_LENGTH), "😀".repeat(MAX_BODY_LENGTH / 2)]
    for (const [index, text] of texts.entries()) {
      const ids = {
        conversationId: conversation,
        questionId: `1111111${index}-1111-4111-8111-111111111111`,
        answerId: `2222222${index}-2222-4222-8222-222222222222`,
      }
      // Past the 65,536 bytes a submit once carried, or, for four-byte pairs, at 64,000 before the command around them.
      expect(new TextEncoder().encode(JSON.stringify(text)).length).toBeGreaterThan(index < 2 ? 65_536 : 64_000)
      const asked = { ...question, ...ids, question: { ...question.question, text: "Why?" } }
      expect(yield* bridge.asked(asked)).toBe("ok")
      // The answer, and the same answer given again: the shard holds it finished, never left streaming.
      expect(yield* bridge.answered({ ...asked, text, updatedAt: ANSWERED_AT })).toBe("ok")
      expect(yield* bridge.answered({ ...asked, text, updatedAt: ANSWERED_AT })).toBe("ok")
      const stored = (yield* messagesOf(host)).find((message) => message.id === ids.answerId)
      expect(stored?.status).toBe("complete")
      expect(stored?.body === text).toBe(true)
    }
  }))
  expect(count("answered", "ok")).toBe(6)
  expect(lines()).toEqual([])
})

/** The bytes a request takes as the bridge sends it: JSON in UTF-8. */
const wireBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
/** A string of `units` code units JSON writes six bytes each, the most any unit takes. */
const escaped = (units: number) => "\u0001".repeat(units)
const BIGGEST = Number.MAX_SAFE_INTEGER
/** A submit as the bridge builds one, under the largest epoch a shard can name. */
const bridgedRequest = (author: string, id: string, payload: unknown) =>
  ({ version: 2, shard, epoch: BIGGEST, command: { key: [`${author}/${Bridge.BRIDGE_DEVICE}`, id], stream: shard, payload } })
/** A step at every bound: both labels as long as the reducer takes, each unit six bytes, and the longest status. */
const widestPart: MessagePart = { id: escaped(MAX_LABEL_LENGTH), kind: "step", flow: escaped(MAX_LABEL_LENGTH), status: "running" }
const isCommand = Schema.is(ChatCommand)

test("the object reads the longest submit of every command the bridge builds, which the cap a page submits under does not carry", async () => {
  const run = {
    _tag: "UpdateMessageMetadata",
    messageId: answerId,
    parts: Array.from({ length: MAX_PARTS }, () => widestPart),
    modelId: escaped(MAX_LABEL_LENGTH),
    stopReason: escaped(MAX_LABEL_LENGTH),
    inputTokens: BIGGEST,
    outputTokens: BIGGEST,
    updatedAt: escaped(MAX_LABEL_LENGTH),
    failure: "rate_limited",
  }
  const posted = {
    _tag: "PostMessage",
    messageId: questionId,
    author: QUESTION,
    body: escaped(MAX_BODY_LENGTH),
    role: "user",
    position: BIGGEST,
    createdAt: escaped(MAX_LABEL_LENGTH),
    source: { viewId: escaped(MAX_LABEL_LENGTH), event: escaped(MAX_LABEL_LENGTH) },
    data: escaped(MAX_DATA_LENGTH),
  }
  const body = { _tag: "UpdateMessageBody", messageId: answerId, author: ANSWER, body: escaped(MAX_BODY_LENGTH) }
  const note = {
    _tag: "UpdateMessageMetadata",
    messageId: questionId,
    summary: escaped(MAX_SUMMARY_LENGTH),
    summaryRevision: escaped(MAX_LABEL_LENGTH),
    phase: escaped(MAX_MARK_LENGTH),
    arc: escaped(MAX_MARK_LENGTH),
    noteVersion: BIGGEST,
  }
  // Each is a command the reducer takes, at every bound it holds, and its submit is exactly as long as the bound says.
  const longest = {
    question: bridgedRequest(QUESTION, `question:${questionId}`, posted),
    body: bridgedRequest(ANSWER, `body:${answerId}:${MAX_BODY_LENGTH}`, body),
    run: bridgedRequest(ANSWER, `failure:${answerId}:${run.updatedAt}`, run),
    note: bridgedRequest(QUESTION, `noted:${questionId}:${BIGGEST}:again`, note),
  }
  for (const [shape, request] of Object.entries(longest)) {
    expect(isCommand(request.command.payload), shape).toBe(true)
    expect(wireBytes(request), shape).toBe(Routes.COMMAND_BYTES[shape as keyof typeof longest])
  }
  // A step more, or a unit more of any label, is the reducer's to refuse.
  expect(isCommand({ ...run, parts: [...run.parts, widestPart] })).toBe(false)
  expect(isCommand({ ...run, modelId: escaped(MAX_LABEL_LENGTH + 1) })).toBe(false)
  expect(Routes.COMMAND_BYTES).toEqual({ question: 295_445, body: 192_422, run: 206_645, note: 8_729, page: 196_864 })
  // A run at its bounds is past the 192 KiB a page's submit is capped at, and so is a page's submit once the Worker
  // seals its key: the most a sealed key spells, the longest owner kind included, is what the bound adds.
  expect(Routes.COMMAND_BYTES.run).toBeGreaterThan(MAX_MESSAGES_SHARD_BYTES)
  const sealed = await Effect.runPromise(Routes.scopedKey(OWNER_SECRET, conversation, ADA, [`${ADA}/phone`, "1"]))
  expect(Routes.COMMAND_BYTES.page - MAX_MESSAGES_SHARD_BYTES).toBe(wireBytes(sealed) + "sandbox".length - "person".length)
  // One cap carries them all: the longest, rounded up to 64 KiB, and finite.
  expect(Routes.MAX_SHARD_COMMAND_BYTES).toBe(327_680)
  expect(Routes.MAX_SHARD_COMMAND_BYTES % 65_536).toBe(0)
  for (const bytes of Object.values(Routes.COMMAND_BYTES)) expect(bytes).toBeLessThanOrEqual(Routes.MAX_SHARD_COMMAND_BYTES)
  expect(Routes.MAX_SHARD_COMMAND_BYTES - 65_536).toBeLessThan(Math.max(...Object.values(Routes.COMMAND_BYTES)))
})

test("a command past what the object reads sheds its last steps until it fits, its first kept in order, and is otherwise sent as it is", () => {
  const steps = Array.from({ length: 3 }, (_, index): MessagePart => ({ ...widestPart, id: `step-${index}` }))
  const run: ChatCommand = { _tag: "UpdateMessageMetadata", messageId: answerId, parts: steps, modelId: "fable-5-2" }
  const build = (payload: ChatCommand) => ({ command: { payload } })
  const sized = (parts: ReadonlyArray<MessagePart>) => wireBytes(build(parts.length === 0 ? { _tag: "UpdateMessageMetadata", messageId: answerId, modelId: "fable-5-2" } : { ...run, parts }))
  const whole = sized(steps)
  // At the bound exactly, nothing is shed; a byte under it, the last step is.
  expect(Bridge.fitted(run, build, whole)).toEqual(build(run))
  expect(Bridge.fitted(run, build, whole - 1)).toEqual(build({ ...run, parts: steps.slice(0, 2) }))
  expect(Bridge.fitted(run, build, sized(steps.slice(0, 2)))).toEqual(build({ ...run, parts: steps.slice(0, 2) }))
  expect(Bridge.fitted(run, build, sized(steps.slice(0, 2)) - 1)).toEqual(build({ ...run, parts: steps.slice(0, 1) }))
  // With no step left the command carries none, and is sent as it is when even that is too large: the object refuses it.
  const bare = build({ _tag: "UpdateMessageMetadata", messageId: answerId, modelId: "fable-5-2" })
  expect(Bridge.fitted(run, build, sized([]))).toEqual(bare)
  expect(Bridge.fitted(run, build, sized([]) - 1)).toEqual(bare)
  // A command with no steps to shed, or none at all, is sent as it is.
  const empty: ChatCommand = { ...run, parts: [] }
  expect(Bridge.fitted(empty, build, 1)).toEqual(build(empty))
  const body: ChatCommand = { _tag: "UpdateMessageBody", messageId: answerId, author: ANSWER, body: "Because." }
  expect(Bridge.fitted(body, build, 1)).toEqual(build(body))
})

test("an answer at every bound the reducer holds, run and body, ends: finished or abandoned, every command taken, never left streaming", async () => {
  const sent: Array<readonly [string, number, number]> = []
  const { lines } = await observed((host) => Effect.gen(function*() {
    // Where the Worker reaches the object, every submit's size and the object's answer to it are kept.
    const forward: Routes.Forward = (id, request) =>
      Effect.gen(function*() {
        const text = yield* Effect.orDie(request.text)
        const response = yield* host.forward(id, HttpServerRequest.fromWeb(new Request("https://messages.internal/api/messages/submit", {
          method: "POST",
          headers: request.headers,
          body: text,
        })))
        sent.push([decodeSubmit(text).command.key[1], new TextEncoder().encode(text).length, response.status])
        return response
      })
    const bridge = MessagesShardBridge.make(forward)
    // As Postgres holds a run: every step at its bounds, each unit six bytes as JSON, and its model and stop reason in
    // three- and four-byte text. Each field is inside the reducer's bounds, so it is kept whole.
    const run = Source.runOf({
      parts: Array.from({ length: MAX_PARTS }, () => widestPart),
      modelId: "界".repeat(MAX_LABEL_LENGTH),
      stopReason: "😀".repeat(MAX_LABEL_LENGTH / 2),
      inputTokens: BIGGEST,
      outputTokens: BIGGEST,
    })
    expect(run.parts).toHaveLength(MAX_PARTS)
    const text = escaped(MAX_BODY_LENGTH + 1_000)
    for (const [index, failure] of [undefined, "abandoned"].entries()) {
      const ids = {
        conversationId: conversation,
        questionId: `1111111${index}-1111-4111-8111-111111111111`,
        answerId: `2222222${index}-2222-4222-8222-222222222222`,
      }
      const asked = { ...question, ...ids, question: { ...question.question, text: "Why?" } }
      expect(yield* bridge.asked(asked)).toBe("ok")
      const ended: Bridge.Answered = { ...asked, text, updatedAt: ANSWERED_AT, run, ...(failure === undefined ? {} : { failure: "abandoned" as const }) }
      expect(yield* bridge.answered(ended)).toBe("ok")
      const stored = (yield* messagesOf(host)).find((message) => message.id === ids.answerId)!
      expect(stored).toMatchObject({ status: failure === undefined ? "complete" : "failed", ...run, updatedAt: ANSWERED_AT })
      expect(stored.failure).toBe(failure)
      expect(stored.body.length).toBe(MAX_BODY_LENGTH)
      // The run's own command is past the cap a page submits under, and the object takes it.
      const [, bytes, status] = sent.find(([id]) => id.startsWith(failure === undefined ? "updated:" : "failure:") && id.includes(ids.answerId))!
      expect(bytes).toBeGreaterThan(MAX_MESSAGES_SHARD_BYTES)
      expect(bytes).toBeLessThanOrEqual(Routes.MAX_SHARD_COMMAND_BYTES)
      expect(status).toBe(200)
      expect(sent.some(([id]) => id === `${failure === undefined ? "complete" : "failed"}:${ids.answerId}`)).toBe(true)
    }
  }))
  expect(sent.map(([, , status]) => status).every((status) => status === 200)).toBe(true)
  expect(lines()).toEqual([])
})
