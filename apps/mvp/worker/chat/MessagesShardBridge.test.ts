import { MAX_BODY_LENGTH } from "@smthrs/app-state"
import { ShardProtocol } from "@smthrs/sync"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Logger, Metric, Schema, type Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import { rowsOf } from "../../src/features/chat/messagesShard.ts"
import { ada, bob, type ShardHost, shardHost } from "../../src/test/messagesShardHost.ts"
import type { Actor } from "../Actor.vibe"
import * as Messages from "./MessagesShard.ts"
import * as Bridge from "./MessagesShardBridge.ts"
import { MessagesShardBridge } from "./MessagesShardBridge.ts"
import * as Routes from "./MessagesShardRoutes.ts"

// ChatApi's bridge into the messages shards (decision 0170, slice 4c), over each conversation's real object handler and
// its real SQLite (src/test/messagesShardHost.ts). Faults are injected where the Worker reaches the object: `forward`.

const conversation = "3f2b8c1e-5d4a-4b7e-9c1d-2a6f0e8b7c5d"
const questionId = "11111111-1111-4111-8111-111111111111"
const answerId = "22222222-2222-4222-8222-222222222222"
const shard = Messages.shardOf(conversation)
const ADA = Routes.personOwner("ada")
const BOB = Routes.personOwner("bob")
/** The owner names the bridge writes under: each names its message, and nobody. */
const QUESTION = Bridge.questionOwner(questionId)
const ANSWER = Bridge.answerOwner(answerId)
const SECRET = "what the person wrote, which no log line may carry"
const question: Bridge.Asked = { conversationId: conversation, questionId, answerId, text: SECRET }
const answer = (text: string): Bridge.Answered => ({ conversationId: conversation, questionId, answerId, text })

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
    const pending = [
      { id: questionId, author: QUESTION, body: SECRET, status: "posted", hubSeq: 1, role: "user" },
      { id: answerId, author: ANSWER, body: "", status: "streaming", hubSeq: 2, role: "assistant", questionId },
    ]
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
    const done = [pending[0], { ...pending[1], body: "Because.", status: "complete" }]
    expect(yield* messagesOf(host)).toEqual(done)
    expect(yield* seqOf(host)).toBe(5)
    // The same answer given again, and the ask sent again after it: nothing moves, and nothing goes back to streaming.
    expect(yield* bridge.answered(answer("Because."))).toBe("ok")
    expect(yield* bridge.asked(question)).toBe("ok")
    expect(yield* messagesOf(host)).toEqual(done)
    expect(yield* seqOf(host)).toBe(5)

    // The rows chat reads off the shard: the person's question, and an answer that is nobody's question.
    expect(rowsOf({ messages: yield* messagesOf(host) }, { conversationId: conversation }).map((row) =>
      [row.id, row.role, row.text, row.status, row.questionId])).toEqual([
        [questionId, "user", SECRET, "done", null],
        [answerId, "assistant", "Because.", "done", questionId],
      ])

    // Another answer once it is finished: Postgres never takes one, and neither does the shard.
    expect(yield* bridge.answered(answer("Because. And more."))).toBe("refused")
    // Other words of the same length reuse the body's key for other content.
    expect(yield* bridge.answered(answer("Because!"))).toBe("idempotency_conflict")
    expect(yield* messagesOf(host)).toEqual(done)
    expect(yield* seqOf(host)).toBe(5)
  }))
  expect(count("asked", "ok")).toBe(4)
  expect(count("answered", "ok")).toBe(2)
  expect(lines()).toEqual([
    { write: "answered", conversationId: conversation, outcome: "refused", step: "UpdateMessageBody", reason: "terminal_body" },
    { write: "answered", conversationId: conversation, outcome: "idempotency_conflict", step: "UpdateMessageBody" },
  ])
})

test("an answer to a question asked before the bridge brings its own pending answer", async () => {
  await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.answered(answer("Because."))).toBe("ok")
    expect(yield* messagesOf(host)).toEqual([
      { id: answerId, author: ANSWER, body: "Because.", status: "complete", hubSeq: 1, role: "assistant", questionId },
    ])
    expect(yield* seqOf(host)).toBe(4)
    // The ask bridged late: the question is sequenced, and the answer's post and status are its receipts'.
    expect(yield* bridge.asked(question)).toBe("ok")
    expect((yield* messagesOf(host)).map((message) => [message.id, message.status])).toEqual([
      [answerId, "complete"],
      [questionId, "posted"],
    ])
    expect(yield* seqOf(host)).toBe(5)
  }))
})

test("what the bridge wrote is held to the shard's rules: nobody else extends the answer or rewrites the question", async () => {
  await observed((host) => Effect.gen(function*() {
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(question)).toBe("ok")
    const extend = (messageId: string, author: string) => ({ _tag: "UpdateMessageBody", messageId, author, body: SECRET + " more" })
    const ceiling = [[Messages.readCapability(shard), Messages.writeCapability(shard)]]
    const agent: Actor = { ...ada, act: { kind: "agent", id: "run-1", ceiling } }
    const RUN = Routes.ownerOf(agent)
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
    expect(sent).toEqual([])
    expect(yield* seqOf(host)).toBe(0)

    // The question's id is nobody else's to take, stored or not: a page's post under it is refused, with nothing sequenced.
    const taken = yield* Effect.promise(() =>
      submitAs(host, ada, [ADA + "/laptop", "1"], { _tag: "PostMessage", messageId: questionId, author: ADA, body: "another", role: "user" }))
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
    { write: "asked", conversationId: conversation, outcome: "refused", step: "PostMessage", reason: "message_conflict" },
  ])
  expect(logs.filter((log) => log.message === "chat.shard.bridge").every((log) => log.level === "WARN")).toBe(true)
  expect(JSON.stringify(logs)).not.toContain(SECRET)
  expect(JSON.stringify(logs)).not.toContain("ada")
  expect([count("asked", "unavailable"), count("answered", "unavailable"), count("asked", "timeout"), count("asked", "refused")])
    .toEqual([5, 2, 1, 2])
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
      expect(Routes.personOwner(id)).not.toBe(QUESTION)
      expect(Routes.personOwner(id).split(":")).toHaveLength(2)
    }
  }))
})

test("ChatApi's ids are its bridge's before it stores them and while its bridge is late: two other writers cannot take one, and the bridge then lands", async () => {
  const { lines } = await observed((host) => Effect.gen(function*() {
    // Another person, and the asker's own run, each allowed to write here, each posting under ChatApi's ids.
    const ceiling = [[Messages.readCapability(shard), Messages.writeCapability(shard)]]
    const agent: Actor = { ...ada, act: { kind: "agent", id: "run-1", ceiling } }
    const RUN = Routes.ownerOf(agent)
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
    expect(yield* messagesOf(host)).toEqual([
      { id: questionId, author: QUESTION, body: SECRET, status: "posted", hubSeq: 1, role: "user" },
      { id: answerId, author: ANSWER, body: "Because.", status: "complete", hubSeq: 2, role: "assistant", questionId },
    ])
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
    // A conflict with no position, and one placed in this shard, are the shard's own answer.
    expect(yield* MessagesShardBridge.make(conflicting(() => null)).asked(question)).toBe("idempotency_conflict")
    expect(yield* MessagesShardBridge.make(conflicting((id) => ({ shard: id, epoch: 0, seq: 1 }))).asked(question))
      .toBe("idempotency_conflict")
    // One placed in another shard names this shard and contradicts itself: malformed, as the SDK's client reads it.
    expect(yield* MessagesShardBridge.make(conflicting(() => ({ shard: elsewhere, epoch: 0, seq: 1 }))).asked(question))
      .toBe("unavailable")
    expect(yield* seqOf(host)).toBe(0)
  }))
  expect(lines()).toEqual([
    { write: "asked", conversationId: conversation, outcome: "idempotency_conflict", step: "PostMessage" },
    { write: "asked", conversationId: conversation, outcome: "idempotency_conflict", step: "PostMessage" },
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
      expect(yield* bridge.asked({ ...ids, text: "Why?" })).toBe("ok")
      // The answer, and the same answer given again: the shard holds it finished, never left streaming.
      expect(yield* bridge.answered({ ...ids, text })).toBe("ok")
      expect(yield* bridge.answered({ ...ids, text })).toBe("ok")
      const stored = (yield* messagesOf(host)).find((message) => message.id === ids.answerId)
      expect(stored?.status).toBe("complete")
      expect(stored?.body === text).toBe(true)
    }
  }))
  expect(count("answered", "ok")).toBe(6)
  expect(lines()).toEqual([])
})
