import { ShardProtocol } from "@smthrs/sync"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "vitest"
import type { Actor } from "../../../worker/Actor.vibe"
import * as Bridge from "../../../worker/chat/MessagesShardBridge.ts"
import { MessagesShardBridge } from "../../../worker/chat/MessagesShardBridge.ts"
import * as Routes from "../../../worker/chat/MessagesShardRoutes.ts"
import { boundFetch } from "../../device/identity.vibe"
import { ada, bob, branchOf, ownerIn, type ShardHost, shardHost } from "../../test/messagesShardHost"
import { SESSION_ROUTE } from "../auth/contract"
import * as MessagesShard from "./messagesShard"
import * as MessagesShardClient from "./messagesShardClient"
import { shardOf } from "./messagesShardClient"
import * as MessagesShardRows from "./messagesShardRows"
import { batchOf, eventsOf, MessagesReadOnly, type SyncedMessages, type SyncEvent } from "./messagesShardRows"
import type { Message, ShardRow } from "./schema"

// The chat store's read side over a conversation's messages shard, end to end with nothing replaced: ChatApi's bridge
// (worker/chat/MessagesShardBridge.ts) writes the transcript into the real shard over SQLite, and a tab reads it back
// through the HTTP transport and ChatApi's real route (src/test/messagesShardHost.ts) as the rows Electric delivers.
// No Electric and no Postgres run here: the bridge is told what Postgres committed. Faults are the network's.

const conversation = "3f2b8c1e-5d4a-4b7e-9c1d-2a6f0e8b7c5d"
const ORIGIN = "https://smithers.example"
const shard = shardOf(conversation)
const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(program))
const httpOf = (host: ShardHost, actor: Actor | null) =>
  Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, host.fetchAs(actor)))

/** A tab's rows of the conversation, signed in as `actor`, following every 5 milliseconds unless told otherwise. */
const openRows = (host: ShardHost, actor: Actor | null = ada, over: Partial<MessagesShardRows.OpenOptions> = {}) =>
  MessagesShardRows.open({ origin: ORIGIN, conversationId: conversation, follow: "5 millis", within: "2 seconds", ...over })
    .pipe(Effect.provide(httpOf(host, actor)))

/**
 * Who keeps the conversation's refusals, as the store's owners do (src/features/conversations/owners.ts): each refusal
 * its own, numbered as it comes, and removed only by a sync that began at or after it. `told` is each time the
 * conversation was hidden, or shown again, with what `at` read then. Nothing says it may show before the first whole
 * answer. `elsewhere` records a refusal as another tab's reaches this one.
 */
const keeper = <A>(at: () => A) => {
  let seq = 0
  let marks: ReadonlyArray<number> = []
  let hidden = true
  const told: Array<readonly [refused: boolean, at: A]> = []
  const cleared: Array<readonly [fence: number, hidden: boolean]> = []
  const refuse = () => {
    marks = [...marks, ++seq]
    hidden = true
    told.push([true, at()])
  }
  const refusals: MessagesShardRows.Refusals = {
    fence: () => seq,
    refuse,
    clear: (fence) => Effect.sync(() => {
      marks = marks.filter((mark) => mark > fence)
      if (hidden && marks.length === 0) {
        hidden = false
        told.push([false, at()])
      }
      cleared.push([fence, hidden])
    }),
  }
  return { told, cleared, refusals, elsewhere: refuse, hidden: () => hidden }
}

const AT = "2026-11-25 10:00:00.123456+00"
const LATER = "2026-11-25 10:00:07.5+00"
/** The nth exchange Postgres holds: its ids, and the places Postgres gave the pair. */
const exchange = (n: number, text = `Question ${n}`): Bridge.Asked => ({
  conversationId: conversation,
  questionId: `1111111${n}-1111-4111-8111-111111111111`,
  answerId: `2222222${n}-2222-4222-8222-222222222222`,
  question: { text, position: 40 + 2 * n, createdAt: AT },
  answer: { position: 41 + 2 * n, createdAt: AT },
})
const answered = (asked: Bridge.Asked, text: string): Bridge.Answered => ({ ...asked, text, updatedAt: LATER })

const eventually = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    while (!(yield* check)) yield* Effect.sleep(1)
  }).pipe(Effect.timeout(5_000))

/** The rows as a page orders them (queries.ts): by position. */
const read = (rows: SyncedMessages) =>
  Effect.map(rows.toArray, (all) =>
    [...all].sort((left, right) => left.position - right.position).map((row) => `${row.role} ${row.status} ${row.text}`))
const reads = (rows: SyncedMessages, expected: ReadonlyArray<string>) =>
  eventually(Effect.map(read(rows), (now) => JSON.stringify(now) === JSON.stringify(expected)))

/** Every sync event from now on, the latest first, as the store's pill follows them. */
const follow = (rows: SyncedMessages) =>
  Effect.gen(function* () {
    const seen: Array<SyncEvent> = []
    yield* rows.sync.pipe(Stream.runForEach((event) => Effect.sync(() => void seen.push(event))), Effect.forkScoped({ startImmediately: true }))
    return {
      seen,
      /** Waits for an event `match` accepts after the ones seen so far. */
      next: (match: (event: SyncEvent) => boolean) => {
        const from = seen.length
        return eventually(Effect.sync(() => seen.slice(from).some(match)))
      },
    }
  })

test("a tab reads what ChatApi bridged as the rows Electric delivers, and follows the answer as it lands", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const bridge = MessagesShardBridge.make(host.forward)
    const first = exchange(0, "What is a shard?")
    expect(yield* bridge.asked(first)).toBe("ok")
    const rows = yield* openRows(host)
    // Nothing is kept on the device, so there is nothing to restore; the conversation has opened once it synced.
    yield* rows.restored
    yield* rows.preload
    // Each row as its schema says it, without TanStack DB's own `$` fields.
    const plain = (all: ReadonlyArray<Message>) =>
      all.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("$"))))
    expect(plain(yield* rows.toArray)).toEqual([
      {
        id: first.questionId, role: "user", text: "What is a shard?", status: "done", questionId: null, failure: null,
        modelId: null, stopReason: null, inputTokens: null, outputTokens: null, position: 40, createdAt: AT,
        updatedAt: AT, conversationId: conversation, summary: null, summaryRevision: null, phase: null, arc: null,
        shardSeq: 1,
      },
      {
        id: first.answerId, role: "assistant", text: "", status: "streaming", questionId: first.questionId,
        failure: null, modelId: null, stopReason: null, inputTokens: null, outputTokens: null, position: 41,
        createdAt: AT, updatedAt: AT, conversationId: conversation, summary: null, summaryRevision: null, phase: null,
        arc: null, shardSeq: 2,
      },
    ])
    // A tick per batch applied from now on, as a shape's `applied` gives one.
    const ticks = yield* rows.applied.pipe(Stream.take(1), Stream.runCount, Effect.forkScoped({ startImmediately: true }))
    // The answer lands in Postgres and is bridged: the tab shows it finished, with when Postgres last wrote it.
    expect(yield* bridge.answered(answered(first, "One conversation, sequenced."))).toBe("ok")
    const done = yield* rows.awaitRow((row) => row.id === first.answerId && row.status === "done", "5 seconds")
    expect(done).toMatchObject({ text: "One conversation, sequenced.", updatedAt: LATER, position: 41 })
    expect(yield* Fiber.join(ticks)).toBe(1)
    // The timeline's summary, written on the finished answer, arrives with the message.
    expect(yield* bridge.noted({
      conversationId: conversation, messageId: first.answerId, role: "assistant", version: 1,
      notes: { summary: "Why one writer", summaryRevision: "rev1", phase: "", arc: "" },
    })).toEqual({ outcome: "ok", settled: true })
    yield* rows.awaitRow((row) => row.summary === "Why one writer" && row.summaryRevision === "rev1", "5 seconds")
    // A second exchange, asked while the tab is open, reads after the first.
    expect(yield* bridge.asked(exchange(1, "And a replica?"))).toBe("ok")
    yield* reads(rows, [
      "user done What is a shard?",
      "assistant done One conversation, sequenced.",
      "user done And a replica?",
      "assistant streaming ",
    ])
    // Read-only requests only: the tab never submits.
    expect(host.requests.every((request) => request.startsWith("GET "))).toBe(true)
  })))

test("a question that reaches the shard after its answer reads before it: the answer's row alone moves when it arrives, past a row in between", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const asked = exchange(0, "Asked before the bridge")
    const ANSWER = Bridge.answerOwner(asked.answerId)
    // An earlier bridge answered a question it never saw asked: the shard holds the answer alone, with no place.
    const earlier = (id: string, payload: Schema.Json) =>
      Routes.submitAs(host.forward, { author: ANSWER }, {
        version: 2,
        shard,
        epoch: 0,
        command: { key: [`${ANSWER}/${Bridge.BRIDGE_DEVICE}`, id], stream: Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard), payload },
      })
    yield* earlier("answer:" + asked.answerId, { _tag: "PostMessage", messageId: asked.answerId, author: ANSWER, body: "", role: "assistant", questionId: asked.questionId })
    yield* earlier("streaming:" + asked.answerId, { _tag: "UpdateMessageStatus", messageId: asked.answerId, status: "streaming" })
    // A page's own post lands after it, where the shard sequences it.
    const ADA = yield* Effect.promise(() => ownerIn(conversation, ada))
    const posted = yield* Effect.promise(() =>
      host.fetchAs(ada)(`${ORIGIN}/api/conversations/${conversation}/messages/submit`, {
        method: "POST",
        body: JSON.stringify({
          version: 2,
          shard,
          epoch: 0,
          command: { key: [ADA + "/laptop", "1"], stream: shard, payload: { _tag: "PostMessage", messageId: "m1", author: ADA, body: "A page's own post" } },
        }),
      }))
    expect(posted.status).toBe(200)
    const rows = yield* openRows(host)
    yield* rows.preload
    expect((yield* rows.toArray).map((row) => [row.id, row.position])).toEqual([[asked.answerId, 1], ["m1", 3]])
    // The answer names a question the shard does not hold: it is no exchange's answer yet, so it names none.
    expect((yield* rows.toArray).map((row) => row.questionId)).toEqual([null, null])
    // The answer given again brings its question, placed where Postgres holds it. Nothing is dropped, and the answer
    // reads straight after the question it answers: the one row that moves. The row in between stays where it read.
    expect(yield* MessagesShardBridge.make(host.forward).answered(answered(asked, "Answered after it."))).toBe("kept")
    yield* reads(rows, ["user done A page's own post", "user done Asked before the bridge", "assistant done Answered after it."])
    expect(Object.fromEntries((yield* rows.toArray).map((row) => [row.id, row.position])))
      .toEqual({ [asked.questionId]: 40, [asked.answerId]: 41, m1: 3 })
    // The pair is ChatApi's own now, both posted by its bridge: the answer's row names its question.
    yield* rows.awaitRow((row) => row.id === asked.answerId && row.questionId === asked.questionId, "5 seconds")
    // A later post of the page's reads after the exchange, not among the rows before it.
    const later = yield* Effect.promise(() =>
      host.fetchAs(ada)(`${ORIGIN}/api/conversations/${conversation}/messages/submit`, {
        method: "POST",
        body: JSON.stringify({
          version: 2,
          shard,
          epoch: 0,
          // It names the bridge's question as the one it answers, which no page's post is taken at its word for.
          command: {
            key: [ADA + "/laptop", "2"],
            stream: shard,
            payload: { _tag: "PostMessage", messageId: "m2", author: ADA, body: "A later post", questionId: asked.questionId },
          },
        }),
      }))
    expect(later.status).toBe(200)
    yield* reads(rows, [
      "user done A page's own post", "user done Asked before the bridge", "assistant done Answered after it.", "user done A later post",
    ])
    expect((yield* rows.toArray).find((row) => row.id === "m2")).toMatchObject({ position: 42, createdAt: "", updatedAt: "", questionId: null })
    // The shard holds what the post said; the row a timeline reads does not carry it. The real answer still does.
    expect((yield* host.state(conversation)).chat.messages.find((message) => message.id === "m2")?.questionId).toBe(asked.questionId)
    expect((yield* rows.toArray).filter((row) => row.questionId === asked.questionId).map((row) => row.id)).toEqual([asked.answerId])
    // Each row carries the entry that posted it, which orders rows that share a place as the shard holds them.
    expect(Object.fromEntries((yield* rows.toArray).map((row) => [row.id, (row as ShardRow).shardSeq])))
      .toEqual({ [asked.answerId]: 1, m1: 3, [asked.questionId]: 4, m2: 8 })
  })))

test("the pill's signal: offline fails and recovers, a refusal stops the following until Retry, an unreadable answer says so", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(exchange(0))).toBe("ok")
    // Offline from the start: the conversation has not opened, and every request fails.
    host.fail("offline", "", 1_000)
    const rows = yield* openRows(host)
    const events = yield* follow(rows)
    yield* rows.restored
    const opening = yield* rows.preload.pipe(Effect.forkScoped({ startImmediately: true }))
    yield* events.next((event) => event._tag === "Failed")
    expect(events.seen.every((event) => event._tag === "Failed" && event.status === undefined)).toBe(true)
    expect(opening.pollUnsafe()).toBeUndefined()
    expect(yield* rows.toArray).toEqual([])
    // Back online: the next follow reaches the shard, and the conversation opens with its messages.
    host.heal()
    yield* events.next((event) => event._tag === "Succeeded")
    yield* Fiber.join(opening)
    expect(yield* read(rows)).toEqual(["user done Question 0", "assistant streaming "])

    // A gateway that fails, then one that garbles the answer: both can be retried, and say what was answered.
    host.fail({ status: 503 }, "", 3)
    yield* events.next((event) => event._tag === "Failed" && event.status === 503)
    host.heal()
    host.fail("garbled", "", 3)
    yield* events.next((event) => event._tag === "Failed" && event.status === 200)
    host.heal()
    yield* events.next((event) => event._tag === "Succeeded")

    // ChatApi decides against the reader: the conversation is no longer theirs to view. The sync stops, and stays
    // stopped: no request follows until Retry.
    host.grant(() => undefined)
    yield* events.next((event) => event._tag === "Stopped" && event.error.status === 404)
    const stoppedAt = host.requests.length
    yield* Effect.sleep(60)
    expect(host.requests.length).toBe(stoppedAt)
    // ChatApi said this person may not read the conversation: what the tab showed of it is gone at once, whatever
    // the data gate would still show of its repository.
    yield* reads(rows, [])
    // Retry while still refused asks once and stops again.
    const refusedAgain = events.next((event) => event._tag === "Stopped" && event.error.status === 404)
    yield* rows.reconnect
    yield* refusedAgain
    yield* Effect.sleep(30)
    expect(host.requests.length).toBe(stoppedAt + 1)
    expect(yield* read(rows)).toEqual([])
    // Access returns, and what was bridged meanwhile: Retry syncs, and the following resumes on its own after it.
    host.grant((_, conversationId) => ({
      branchId: "branch-1", conversationId, repoId: "example/project", name: "main", mode: "open", createdBy: "ada",
      access: "view", role: "member", shared: false,
    }))
    expect(yield* bridge.answered(answered(exchange(0), "Answered."))).toBe("ok")
    const back = events.next((event) => event._tag === "Succeeded")
    yield* rows.reconnect
    yield* back
    yield* reads(rows, ["user done Question 0", "assistant done Answered."])
    expect(yield* bridge.asked(exchange(1))).toBe("ok")
    yield* reads(rows, ["user done Question 0", "assistant done Answered.", "user done Question 1", "assistant streaming "])
  })))

test("a conversation no request may be built for stops without a status, and a signed-out tab is refused", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const nowhere = yield* openRows(host, ada, { conversationId: "../admin" })
    const events = yield* follow(nowhere)
    yield* events.next((event) => event._tag === "Stopped")
    expect(events.seen).toEqual([{ _tag: "Stopped", error: {} }])
    expect(host.requests).toEqual([])
    const signedOut = yield* follow(yield* openRows(host, null))
    yield* signedOut.next((event) => event._tag === "Stopped" && event.error.status === 401)
  })))

test("the rows are read-only: a write rolls back, and nothing is submitted", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    expect(yield* MessagesShardBridge.make(host.forward).asked(exchange(0))).toBe("ok")
    const rows = yield* openRows(host)
    yield* rows.preload
    const [question] = yield* rows.toArray
    const failureOf = (write: { readonly persisted: Effect.Effect<void, unknown> }) =>
      Effect.map(Effect.flip(write.persisted), (failed) => {
        let error: unknown = failed
        while (!(error instanceof MessagesReadOnly) && error instanceof Error && error.cause !== undefined) error = error.cause
        return error
      })
    const mine: Message = { ...question!, id: "mine", text: "Written here" }
    expect(yield* failureOf(yield* rows.insert(mine))).toBeInstanceOf(MessagesReadOnly)
    expect(yield* failureOf(yield* rows.update(question!.id, (draft) => void (draft.text = "Rewritten")))).toBeInstanceOf(MessagesReadOnly)
    expect(yield* failureOf(yield* rows.delete(question!.id))).toBeInstanceOf(MessagesReadOnly)
    expect(yield* rows.get("mine")).toEqual(Option.none())
    expect(yield* read(rows)).toEqual(["user done Question 0", "assistant streaming "])
    expect(host.requests.some((request) => request.includes("/submit"))).toBe(false)
  })))

test("two tabs read one conversation; one closing takes nothing with it, and a tab opened later rebuilds from the snapshot", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(exchange(0))).toBe("ok")
    // Another person's tab, and the asker's, which closes mid-conversation: each has a replica of its own.
    const theirs = yield* openRows(host, bob)
    const closing = yield* Scope.make()
    const mine = yield* openRows(host, ada, { limit: 1 }).pipe(Scope.provide(closing))
    yield* Effect.all([theirs.preload, mine.preload])
    // One entry a page: the same rows, however many requests they took.
    const pending = ["user done Question 0", "assistant streaming "]
    expect([yield* read(mine), yield* read(theirs)]).toEqual([pending, pending])
    yield* Scope.close(closing, Exit.void)
    // The tab that stayed follows on, alone.
    expect(yield* bridge.answered(answered(exchange(0), "Answered."))).toBe("ok")
    expect(yield* bridge.asked(exchange(1))).toBe("ok")
    const whole = ["user done Question 0", "assistant done Answered.", "user done Question 1", "assistant streaming "]
    yield* reads(theirs, whole)
    // The closed tab holds nothing and asks for nothing: its collection went with its scope, one page at a time no more.
    expect(yield* read(mine)).toEqual([])
    const after = host.requests.length
    yield* Effect.sleep(30)
    expect(host.requests.slice(after).some((request) => request.includes("limit=1"))).toBe(false)
    // The shard folds its history into a snapshot. A tab opened now reads the same conversation from it.
    yield* host.compact(conversation)
    const reopened = yield* openRows(host)
    yield* reopened.preload
    expect(yield* read(reopened)).toEqual(whole)
    expect(yield* reopened.toArray).toEqual(yield* theirs.toArray)
    expect(host.requests.some((request) => request.includes("/snapshot"))).toBe(true)
  })))

test("a replica rebuilt from another history drops the rows that history lacks, then shows what it holds", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    expect(yield* MessagesShardBridge.make(host.forward).asked(exchange(0))).toBe("ok")
    const rows = yield* openRows(host, ada, { follow: "1 hour" })
    yield* rows.preload
    const changes: Array<string> = []
    yield* rows.changes().pipe(
      Stream.flattenIterable,
      Stream.runForEach((change) => Effect.sync(() => void changes.push(`${change.type} ${change.key}`))),
      Effect.forkScoped({ startImmediately: true }),
    )
    // The shard answers that the tab's cursor is outside its history, and its snapshot is of nothing: every row
    // leaves at once. The entries after the snapshot then bring the conversation back.
    host.fail(async () => Response.json({ _tag: "Resync", shard, epoch: 0, snapshotSeq: 0 }), "/pull")
    host.fail(async (answer) => Response.json({ ...(await answer.json() as object), position: { shard, epoch: 0, seq: 0 }, state: null }), "/snapshot")
    yield* rows.reconnect
    yield* eventually(Effect.sync(() => changes.length === 4))
    const [question, answer] = [exchange(0).questionId, exchange(0).answerId]
    expect([...changes.slice(0, 2)].sort()).toEqual([`delete ${question}`, `delete ${answer}`].sort())
    expect(changes.slice(2)).toEqual([`insert ${question}`, `insert ${answer}`])
    expect(yield* read(rows)).toEqual(["user done Question 0", "assistant streaming "])
  })))

test("preload waits for the rows the projection holds now, not for as many: an update that leaves the count as it was is not skipped", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const bridge = MessagesShardBridge.make(host.forward)
    const asked = exchange(0, "What is a shard?")
    expect(yield* bridge.asked(asked)).toBe("ok")
    expect(yield* bridge.answered(answered(asked, "One conversation, sequenced."))).toBe("ok")
    expect(yield* bridge.noted({
      conversationId: conversation, messageId: asked.answerId, role: "assistant", version: 1,
      notes: { summary: "Why one writer", summaryRevision: "rev1", phase: "", arc: "" },
    })).toEqual({ outcome: "ok", settled: true })
    // One entry a page: the two rows are there after the second, and the five entries after it only change them.
    const rows = yield* openRows(host, ada, { follow: "1 hour", limit: 1 })
    yield* rows.preload
    // Read at once, with no wait: the collection already shows the last of them.
    expect((yield* rows.toArray).map((row) => [row.role, row.status, row.text, row.updatedAt, row.summary])).toEqual([
      ["user", "done", "What is a shard?", AT, null],
      ["assistant", "done", "One conversation, sequenced.", LATER, "Why one writer"],
    ])
    expect(host.requests.filter((request) => request.includes("/pull")).length).toBeGreaterThanOrEqual(7)
  })))

/** A page's own submit to the conversation's shard, as `actor`: its status. */
const submitAs = (host: ShardHost, actor: Actor, key: readonly [string, string], payload: object) =>
  Effect.promise(async () =>
    (await host.fetchAs(actor)(`${ORIGIN}/api/conversations/${conversation}/messages/submit`, {
      method: "POST",
      body: JSON.stringify({ version: 2, shard, epoch: 0, command: { key, stream: shard, payload } }),
    })).status)

test("a row whose steps first appear, change and stay is followed and opened whole: readiness never compares a field a row lacks", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const AGENT: Actor = { ...ada, act: { kind: "agent", id: "run-1", ceiling: [[`messages:read:${shard}`, `messages:write:${shard}`]] } as never }
    const OWNER = yield* Effect.promise(() => ownerIn(conversation, AGENT))
    const node = `${OWNER}/run`
    expect(yield* submitAs(host, AGENT, [node, "1"], { _tag: "PostMessage", messageId: "m1", author: OWNER, body: "Working" })).toBe(200)
    const rows = yield* openRows(host)
    yield* rows.preload
    expect((yield* rows.toArray).map((row) => Object.hasOwn(row, "parts"))).toEqual([false])
    const ticks = yield* rows.applied.pipe(Stream.take(2), Stream.runCount, Effect.forkScoped({ startImmediately: true }))
    // The run records its first step: the row gains a field it did not have.
    const step = (status: "running" | "done") => ({ _tag: "UpdateMessageMetadata", messageId: "m1", parts: [{ id: "0.0", kind: "step", flow: "chat/copy", status }] })
    expect(yield* submitAs(host, AGENT, [node, "2"], step("running"))).toBe(200)
    yield* rows.awaitRow((row) => row.parts?.[0]?.status === "running", "5 seconds")
    // The step ends: the same field, another value.
    expect(yield* submitAs(host, AGENT, [node, "3"], step("done"))).toBe(200)
    yield* rows.awaitRow((row) => row.parts?.[0]?.status === "done", "5 seconds")
    expect(yield* Fiber.join(ticks)).toBe(2)
    // A tab opened now, one entry a page, passes through the row without the field, with it, and with it changed:
    // it opens once, whole, on the last.
    const late = yield* openRows(host, ada, { follow: "1 hour", limit: 1 })
    yield* late.whole!
    expect((yield* late.toArray).map((row) => row.parts)).toEqual([[{ id: "0.0", kind: "step", flow: "chat/copy", status: "done" }]])
  })))

test("a retry that finds nothing new still says the rows are applied, so a recorded failure is cleared; a quiet sync says nothing", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    expect(yield* MessagesShardBridge.make(host.forward).asked(exchange(0))).toBe("ok")
    const rows = yield* openRows(host)
    yield* rows.preload
    const events = yield* follow(rows)
    let ticks = 0
    yield* rows.applied.pipe(Stream.runForEach(() => Effect.sync(() => void ticks++)), Effect.forkScoped({ startImmediately: true }))
    // Syncs that succeed and bring nothing: no tick, however many.
    yield* Effect.sleep(60)
    expect(ticks).toBe(0)
    // The shard cannot be reached, then can: nothing was sequenced meanwhile, and the first sync that succeeds ticks.
    host.fail({ status: 503 }, "", 1_000)
    yield* events.next((event) => event._tag === "Failed" && event.status === 503)
    expect(ticks).toBe(0)
    host.heal()
    yield* events.next((event) => event._tag === "Succeeded")
    yield* eventually(Effect.sync(() => ticks === 1))
    yield* Effect.sleep(60)
    expect(ticks).toBe(1)
    expect(yield* read(rows)).toEqual(["user done Question 0", "assistant streaming "])
    // What a load's observer hears (load.ts): the failure once, then the recovery, from the empty retry alone.
    const heard: Array<string> = []
    const watched = Stream.merge(Stream.map(rows.sync, (event) => event._tag), Stream.map(rows.applied, () => "Applied"))
    yield* watched.pipe(Stream.runForEach((tag) => Effect.sync(() => void heard.push(tag))), Effect.forkScoped({ startImmediately: true }))
    host.fail("offline", "", 1_000)
    yield* eventually(Effect.sync(() => heard.includes("Failed")))
    host.heal()
    yield* eventually(Effect.sync(() => heard.includes("Applied")))
    expect(heard.indexOf("Applied")).toBeGreaterThan(heard.indexOf("Failed"))
  })))

test("a reader ChatApi refuses loses the conversation's rows at once, for 401, 403 and 404, and keeps them through a failure a retry can fix", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(exchange(0))).toBe("ok")
    // What the store is told of each refusal, with how many rows the collection held at that moment.
    const holder: { rows?: SyncedMessages } = {}
    const { told, refusals, hidden } = keeper(() => holder.rows!.tanstack.size)
    const rows = yield* openRows(host, ada, { refusals })
    holder.rows = rows
    const events = yield* follow(rows)
    yield* rows.preload
    const populated = ["user done Question 0", "assistant streaming "]
    expect(yield* read(rows)).toEqual(populated)
    // The first read ChatApi answered whole is told as allowed, with its rows held: a refusal the device kept from an
    // earlier load stands until then, and no longer.
    yield* eventually(Effect.sync(() => told.length === 1))
    expect(told).toEqual([[false, 2]])
    // Failures that are not ChatApi's word on who may read say nothing of it: a gateway's 503 and no network. The rows
    // stay.
    for (const fault of [{ status: 503 }, "offline"] as const) {
      host.fail(fault, "", 3)
      yield* events.next((event) => event._tag === "Failed")
      expect(yield* read(rows)).toEqual(populated)
      host.heal()
      yield* events.next((event) => event._tag === "Succeeded")
    }
    // A 401 is ChatApi's word on the read, even one the page's transport found is still this person's session and
    // goes on retrying: the rows go with the answer, and return with the retry ChatApi serves.
    host.fail({ status: 401, sameSession: true }, "", 3)
    yield* events.next((event) => event._tag === "Failed" && event.status === 401)
    yield* reads(rows, [])
    expect(yield* rows.toArray).toEqual([])
    host.heal()
    yield* events.next((event) => event._tag === "Succeeded")
    yield* reads(rows, populated)
    // The store was told of the refusal while the rows were still held, so whatever else it shows of the conversation
    // is hidden no later than they are; and told it is over only once the rows ChatApi served again are held, never
    // while there are none. Nothing was said for the failures before, which are no word on access.
    yield* eventually(Effect.sync(() => told.length === 3))
    expect(told).toEqual([[false, 2], [true, 2], [false, 2]])
    // A body ChatApi could not take (400) is refused, and is no word on access either.
    host.fail({ status: 400 }, "", 1)
    yield* events.next((event) => event._tag === "Stopped" && event.error.status === 400)
    yield* Effect.sleep(20)
    expect(yield* read(rows)).toEqual(populated)
    const again = events.next((event) => event._tag === "Succeeded")
    yield* rows.reconnect
    yield* again
    // Each answer that says this person may not read the conversation empties the rows, and a sync ChatApi answers
    // brings them back, with what was sequenced meanwhile.
    let n = 0
    for (const status of [401, 403, 404]) {
      host.fail({ status }, "", 1)
      yield* events.next((event) => event._tag === "Stopped" && event.error.status === status)
      yield* reads(rows, [])
      expect(yield* rows.toArray).toEqual([])
      expect(yield* bridge.asked(exchange(++n))).toBe("ok")
      const back = events.next((event) => event._tag === "Succeeded")
      yield* rows.reconnect
      yield* back
      yield* reads(rows, [...populated, ...Array.from({ length: n }, (_, index) => [`user done Question ${index + 1}`, "assistant streaming "]).flat()])
    }
    // The branch's share is taken from the person while the repository is still theirs: ChatApi answers 403 itself.
    host.grant((_, conversationId) => branchOf(conversationId, { access: "none" as never }))
    yield* events.next((event) => event._tag === "Stopped" && event.error.status === 403)
    yield* reads(rows, [])
    // Another reader's read of the conversation begins now, after that refusal: it takes where the refusals stand.
    const sibling = refusals.fence()
    // Asking again while still refused shows nothing, and is a refusal of its own: the store is told again, with the
    // conversation hidden already and no row held.
    const refused = events.next((event) => event._tag === "Stopped" && event.error.status === 403)
    yield* rows.reconnect
    yield* refused
    expect(yield* read(rows)).toEqual([])
    yield* eventually(Effect.sync(() => told.length === 11))
    expect(told.at(-1)).toEqual([true, 0])
    // The other reader's read is answered whole only now. Its answer may be older than the second refusal, which it
    // did not begin after: the refusal stands, and the conversation stays hidden.
    expect(refusals.fence()).toBeGreaterThan(sibling)
    refusals.clear(sibling)
    expect(hidden()).toBe(true)
    // Shared again: the rows return only with the sync that ChatApi answers.
    host.grant((_, conversationId) => branchOf(conversationId, { access: "view" }))
    const shared = events.next((event) => event._tag === "Succeeded")
    yield* rows.reconnect
    yield* shared
    yield* reads(rows, [...populated, ...[1, 2, 3].flatMap((index) => [`user done Question ${index}`, "assistant streaming "])])
    // Every first refusal was told with the rows still held, and every return with the rows back: the 401 above,
    // then 401, 403, 404 and the share taken away, and that refusal again when the read was refused again.
    yield* eventually(Effect.sync(() => told.length === 12))
    expect(told.map(([refused]) => refused)).toEqual([false, true, false, true, false, true, false, true, false, true, true, false])
    expect(told.map(([, held]) => held)).toEqual([2, 2, 2, 2, 4, 4, 6, 6, 8, 8, 0, 8])
  })))

test("a sync answered whole clears only the refusals it began after: one another tab recorded once it had begun stands until the next sync's answer", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(exchange(0))).toBe("ok")
    const { told, cleared, refusals, elsewhere } = keeper(() => undefined)
    // Another tab's refusal reaches this one just after a sync of this tab's began: armed below, for one sync.
    const arrives = { armed: false }
    const rows = yield* openRows(host, ada, { refusals: { ...refusals, fence: () => {
      const fence = refusals.fence()
      if (arrives.armed) {
        arrives.armed = false
        elsewhere()
      }
      return fence
    } } })
    yield* rows.preload
    yield* eventually(Effect.sync(() => told.length === 1))
    // Every sync so far began with no refusal known, and said so.
    expect(told.map(([refused]) => refused)).toEqual([false])
    expect(new Set(cleared.map(([fence]) => fence))).toEqual(new Set([0]))
    arrives.armed = true
    yield* eventually(Effect.sync(() => told.length === 3))
    // The sync that had begun was answered whole, and cleared nothing: the refusal is later than where it began. The
    // sync after it began past the refusal, and its answer shows the conversation again.
    expect(told.map(([refused]) => refused)).toEqual([false, true, false])
    const since = cleared.slice(cleared.findIndex(([, hidden]) => hidden))
    expect(since.slice(0, 2)).toEqual([[0, true], [1, false]])
  })))

test("a Pull ChatApi answers 401 hides the conversation as the answer arrives, and it stays hidden though the session read after it outlasts the deadline", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(exchange(0))).toBe("ok")
    // The page's real transport (src/main.tsx): `boundFetch`, which reads the session again after a 401, over a
    // `fetch` that tells each read's 401 as it arrives.
    const denials = MessagesShardClient.readDenials()
    const page = boundFetch(denials.observing(host.fetchAs(ada)), { origin: ORIGIN, principal: () => ada.subject.id, reauthorize: async () => false })
    const http = Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, page))
    const populated = ["user done Question 0", "assistant streaming "]

    // The store's rows, told of the 401s: hidden with the answer, and the read is reported as ChatApi answered it.
    const seen: { events?: ReadonlyArray<SyncEvent> } = {}
    const failures = () => (seen.events ?? []).filter((event) => event._tag !== "Succeeded").length
    const { told, refusals: keeping } = keeper(failures)
    const rows = yield* MessagesShardRows.open({
      origin: ORIGIN, conversationId: conversation, follow: "5 millis", within: "150 millis", denials, refusals: keeping,
    }).pipe(Effect.provide(http))
    const events = yield* follow(rows)
    seen.events = events.seen
    yield* rows.preload
    expect(yield* read(rows)).toEqual(populated)
    yield* eventually(Effect.sync(() => told.length === 1))
    // Every Pull is answered 401, and no session read after one is ever answered.
    host.fail({ status: 401 }, "/messages/pull", 1_000)
    host.fail("stall", SESSION_ROUTE, 1_000)
    const stopped = events.next((event) => event._tag === "Stopped" && event.error.status === 401)
    yield* reads(rows, [])
    // Hidden, and the store told, before any sync had failed: the request the 401 answered is still out, waiting on
    // the session read, and its deadline is yet to come.
    expect(told).toEqual([[false, 0], [true, 0]])
    expect(failures()).toBe(0)
    yield* stopped
    // Past the deadline the read is refused as ChatApi answered it, and nothing has returned.
    expect(yield* rows.toArray).toEqual([])
    yield* Effect.sleep(400)
    expect(yield* rows.toArray).toEqual([])
    expect(told).toEqual([[false, 0], [true, 0]])
    // Asking again while ChatApi still refuses, and the session read still stalls, shows nothing.
    const still = events.next((event) => event._tag === "Stopped" && event.error.status === 401)
    yield* rows.reconnect
    yield* still
    expect(yield* rows.toArray).toEqual([])
    // ChatApi serves the read again: the rows return with that answer, and the store is told once they are held.
    host.heal()
    const back = events.next((event) => event._tag === "Succeeded")
    yield* rows.reconnect
    yield* back
    yield* reads(rows, populated)
    // The read refused again while hidden was told too, as it arrived; then the return.
    yield* eventually(Effect.sync(() => told.length === 4))
    expect(told.map(([refused]) => refused)).toEqual([false, true, true, false])

    // A replica whose transport is told nothing of the 401 reports the read as unreachable at its deadline, and goes
    // on asking; the conversation is hidden all the same, from the answer on, until a sync ChatApi answers whole.
    const transport = yield* MessagesShardClient.make({ origin: ORIGIN, conversationId: conversation, within: "150 millis" }).pipe(Effect.provide(http))
    const replica = yield* MessagesShard.make({ conversationId: conversation, node: MessagesShardClient.nodeOf("reader", "rows"), transport, denials })
    yield* replica.resume
    expect((yield* replica.chat).messages.map((message) => message.body)).toEqual(["Question 0", ""])
    let refusals = 0
    yield* replica.onRefused(() => void refusals++)
    host.fail({ status: 401 }, "/messages/pull", 1_000)
    host.fail("stall", SESSION_ROUTE, 1_000)
    const resumed = yield* Effect.forkScoped(Effect.flip(replica.resume), { startImmediately: true })
    yield* eventually(Effect.sync(() => replica.refused()))
    // Told as the answer arrived, and again for any 401 the store's reader above was given meanwhile.
    expect(refusals).toBeGreaterThan(0)
    expect((yield* replica.chat).messages).toEqual([])
    // The sync has not ended: the conversation was hidden by the answer, not by the deadline.
    expect((yield* SubscriptionRef.get(replica.status)).state).toBe("ok")
    expect(yield* Fiber.join(resumed)).toEqual(new MessagesShardClient.MessagesShardUnavailable({ request: "pull", reason: "unreachable" }))
    expect((yield* SubscriptionRef.get(replica.status)).state).toBe("failing")
    expect(replica.refused()).toBe(true)
    expect((yield* replica.chat).messages).toEqual([])
    // The same again shows nothing, and is told again: each 401 that arrives while the conversation is hidden, this
    // read's and the store's reader's above alike, is a refusal of its own.
    const before = refusals
    expect((yield* Effect.flip(replica.resume)).reason).toBe("unreachable")
    expect(replica.refused()).toBe(true)
    expect(refusals).toBeGreaterThan(before)
    host.heal()
    yield* replica.resume
    expect(replica.refused()).toBe(false)
    expect((yield* replica.chat).messages.map((message) => message.body)).toEqual(["Question 0", ""])
  })))

/** A reader's replica of the conversation over ChatApi's real route, as `MessagesShardRows.open` builds one. */
const openReplica = (host: ShardHost) =>
  Effect.gen(function* () {
    const transport = yield* MessagesShardClient.make({ origin: ORIGIN, conversationId: conversation, within: "2 seconds" })
    return yield* MessagesShard.make({ conversationId: conversation, node: MessagesShardClient.nodeOf("reader", "rows"), transport })
  }).pipe(Effect.provide(httpOf(host, ada)))

test("rows the collection stopped before committing are neither ready nor a recovery, and a refusal is not undone by them", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const bridge = MessagesShardBridge.make(host.forward)
    expect(yield* bridge.asked(exchange(0))).toBe("ok")
    // The real replica, whose projection the collection stops reading after its first batch, once the sync that
    // folded the conversation has reached the head: its apply of the next batch failed (`failed`), or its source
    // ended (`ended`). The replica goes on syncing; the collection commits no more.
    for (const [reason, after] of [["failed", Stream.die("the batch could not be applied")], ["ended", Stream.empty]] as const) {
      // Each in a scope of its own: the replica before it is closed, and takes no answer meant for this one.
      yield* Effect.scoped(Effect.gen(function* () {
        const replica = yield* openReplica(host)
        const { told, refusals } = keeper(() => undefined)
        const stops = yield* Deferred.make<void>()
        const projections = Stream.concat(
          Stream.take(replica.projections, 1),
          Stream.flatMap(Stream.fromEffect(Deferred.await(stops)), () => after),
        )
        const rows = yield* MessagesShardRows.make({ ...replica, projections }, {
          follow: "5 millis",
          refusals,
        })
        const events = yield* follow(rows)
        let ticks = 0
        yield* rows.applied.pipe(Stream.runForEach(() => Effect.sync(() => void ticks++)), Effect.forkScoped({ startImmediately: true }))
        // The sync reached the shard's head, and the replica folded both messages. The collection holds neither, and
        // stops before it does: it is not whole, and says why.
        const whole = yield* rows.whole!.pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
        yield* eventually(Effect.map(SubscriptionRef.get(replica.status), (status) => status.state === "ok"))
        yield* Deferred.succeed(stops, undefined)
        const stopped = yield* Fiber.join(whole)
        expect(Exit.isFailure(stopped) && Cause.squash(stopped.cause)).toMatchObject({ _tag: "JournalStopped", reason })
        // Asked again of a collection that stopped, it loads nothing: a failure of its own, never a success.
        const preloaded = yield* Effect.exit(rows.preload)
        expect(Exit.isFailure(preloaded) && Cause.squash(preloaded.cause)).toMatchObject({ _tag: "LoadFailed" })
        expect((yield* replica.chat).messages.length).toBe(2)
        expect(yield* rows.toArray).toEqual([])
        // A failure, then a sync that succeeds: the replica recovered, and the rows did not. No tick says they did.
        host.fail({ status: 503 }, "", 1_000)
        yield* events.next((event) => event._tag === "Failed" && event.status === 503)
        host.heal()
        yield* events.next((event) => event._tag === "Succeeded")
        yield* Effect.sleep(60)
        expect(ticks).toBe(0)
        // ChatApi refuses the conversation, then serves it again: the store is told of the refusal, and never that it
        // is over, since the rows it would show again were never committed.
        host.fail({ status: 403 }, "", 1)
        yield* events.next((event) => event._tag === "Stopped" && event.error.status === 403)
        const back = events.next((event) => event._tag === "Succeeded")
        yield* rows.reconnect
        yield* back
        yield* Effect.sleep(60)
        expect(told.map(([refused]) => refused)).toEqual([true])
        expect(ticks).toBe(0)
      }))
    }
    // A projection that fails before its first batch: nothing loads, and the failure is the collection's own.
    const replica = yield* openReplica(host)
    const rows = yield* MessagesShardRows.make({ ...replica, projections: Stream.die("no projection") }, { follow: "5 millis" })
    const never = yield* Effect.exit(rows.preload)
    expect(Exit.isFailure(never) && Cause.squash(never.cause)).toMatchObject({ _tag: "LoadFailed" })
    expect(Exit.isFailure(yield* Effect.exit(rows.whole!))).toBe(true)
  })))

test("a batch is the rows that are new or changed; a first one, and one after a row left, is a snapshot", () => {
  const row = (id: string, text = id): Message => ({
    id, role: "user", text, status: "done", questionId: null, failure: null, modelId: null, stopReason: null,
    inputTokens: null, outputTokens: null, position: 1, createdAt: AT, updatedAt: AT, conversationId: conversation,
  })
  const [a, b] = [row("a"), row("b")]
  const shown = new Map([["a", a]])
  expect(batchOf(undefined, [a], 3)).toEqual({ snapshot: true, through: 3, changes: [{ type: "insert", value: a }] })
  expect(batchOf(undefined, [], 0)).toEqual({ snapshot: true, through: 0, changes: [] })
  // An equal row under a new object is no change; a changed one is an update; a new one an insert.
  expect(batchOf(shown, [row("a")], 4)).toEqual({ snapshot: false, through: 4, changes: [] })
  const edited = row("a", "edited")
  expect(batchOf(shown, [edited, b], 5)).toEqual({
    snapshot: false,
    through: 5,
    changes: [{ type: "update", value: edited }, { type: "insert", value: b }],
  })
  expect(batchOf(shown, [b], 6)).toEqual({ snapshot: true, through: 6, changes: [{ type: "insert", value: b }] })
  expect(batchOf(shown, [], 7)).toEqual({ snapshot: true, through: 7, changes: [] })
})

test("a replica's status reads as a shape's sync events", () => {
  expect(eventsOf({ state: "pending", through: 0, version: 0, fence: 0 })).toEqual([])
  expect(eventsOf({ state: "ok", through: 4, version: 2, fence: 0 })).toEqual([{ _tag: "Succeeded" }])
  expect(eventsOf({ state: "failing", through: 4, version: 2, fence: 0 })).toEqual([{ _tag: "Failed" }])
  expect(eventsOf({ state: "failing", through: 4, version: 2, fence: 0, status: 503 })).toEqual([{ _tag: "Failed", status: 503 }])
  expect(eventsOf({ state: "refused", through: 4, version: 3, fence: 0, status: 403 })).toEqual([{ _tag: "Stopped", error: { status: 403 } }])
  expect(eventsOf({ state: "refused", through: 4, version: 3, fence: 0 })).toEqual([{ _tag: "Stopped", error: {} }])
})

test("rows that follow the home read each conversation named, each with its own refusals, and nothing of the one before", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const bridge = MessagesShardBridge.make(host.forward)
    const other = "4a3c9d2f-6e5b-4c8f-8d2e-3b7a1f9c8d6e"
    expect(yield* bridge.asked(exchange(0, "Home question"))).toBe("ok")
    expect(yield* bridge.asked({ ...exchange(1, "Other question"), conversationId: other })).toBe("ok")
    const named = yield* Queue.unbounded<string | undefined>()
    // Who keeps each conversation's refusals: one keeper each time a conversation is named, bound to it.
    const keepers: Array<readonly [string, ReturnType<typeof keeper<string>>]> = []
    const keeperOf = (id: string) => keepers.filter(([named]) => named === id).at(-1)![1]
    const rows = yield* MessagesShardRows.following({
      origin: ORIGIN,
      follow: "5 millis",
      within: "2 seconds",
      conversations: Stream.fromQueue(named),
      refusalsOf: (id) => {
        const kept = keeper(() => id)
        keepers.push([id, kept])
        return kept.refusals
      },
    }).pipe(Effect.provide(httpOf(host, ada)))
    const events = yield* follow(rows)
    const whole = yield* rows.whole.pipe(Effect.forkScoped({ startImmediately: true }))
    // Nothing named yet: nothing is read, nothing said, and the rows are not whole. Retry has nothing to sync.
    yield* rows.reconnect
    yield* Effect.sleep(40)
    expect(events.seen).toEqual([])
    expect(whole.pollUnsafe()).toBeUndefined()
    expect(yield* rows.toArray).toEqual([])

    // The home is named: its rows, whole, each naming it; its keeper is told it may show.
    yield* Queue.offer(named, conversation)
    yield* Fiber.join(whole)
    yield* reads(rows, ["user done Home question", "assistant streaming "])
    expect((yield* rows.toArray).every((row) => row.conversationId === conversation)).toBe(true)
    yield* eventually(Effect.sync(() => keeperOf(conversation).told.some(([refused]) => !refused)))
    // Named again, it is the same read: no second replica, no second keeper.
    yield* Queue.offer(named, conversation)
    yield* Effect.sleep(20)
    expect(keepers.map(([id]) => id)).toEqual([conversation])

    // Another is named: the rows move to it in one snapshot, and the one before is no longer read or cleared.
    yield* Queue.offer(named, other)
    yield* reads(rows, ["user done Other question", "assistant streaming "])
    expect((yield* rows.toArray).every((row) => row.conversationId === other)).toBe(true)
    yield* eventually(Effect.sync(() => keeperOf(other).told.some(([refused]) => !refused)))
    const before = keeperOf(conversation).cleared.length
    yield* bridge.answered(answered(exchange(0, "Home question"), "Home answer"))
    yield* Effect.sleep(60)
    expect(keeperOf(conversation).cleared.length).toBe(before)
    expect(yield* read(rows)).toEqual(["user done Other question", "assistant streaming "])

    // ChatApi refuses the one named now: its own keeper is told, and its rows go; the home's keeper is told nothing.
    host.grant((_, id) => (id === other ? undefined : branchOf(id)))
    yield* eventually(Effect.sync(() => keeperOf(other).told.at(-1)?.[0] === true))
    yield* reads(rows, [])
    expect(keeperOf(conversation).told.every(([refused]) => !refused)).toBe(true)
    host.grant((_, id) => branchOf(id))

    // None is named: the rows are empty, and that is a sync that succeeded. Retry has nothing to sync.
    yield* Queue.offer(named, undefined)
    yield* events.next((event) => event._tag === "Succeeded")
    yield* reads(rows, [])
    yield* rows.reconnect
    // The home named again is read again, under a keeper of its own, with what the shard holds now.
    yield* Queue.offer(named, conversation)
    yield* reads(rows, ["user done Home question", "assistant done Home answer"])
    expect(keepers.map(([id]) => id)).toEqual([conversation, other, conversation])
    yield* eventually(Effect.sync(() => keeperOf(conversation).told.some(([refused]) => !refused)))
  })))
