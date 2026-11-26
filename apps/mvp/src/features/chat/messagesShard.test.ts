import { canonicalHash, emptyChat } from "@smthrs/app-state"
import { JournalCollection } from "@smthrs/effect-tanstack-db"
import { ShardClient, ShardProtocol } from "@smthrs/sync"
import { Context, Effect, Exit, Layer, Option, Schedule, Schema, Scope, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { join } from "node:path"
import { expect, test } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import * as WorkerShard from "../../../worker/chat/MessagesShard.ts"
import { ada, bob, branchOf, type ShardHost, shardHost } from "../../test/messagesShardHost"
import { tempDirectory } from "../../test/tempDirectory"
import * as MessagesShard from "./messagesShard"
import { MessagesShards, MessagesWriteRefused, type ShardMessage } from "./messagesShard"
import * as MessagesShardClient from "./messagesShardClient"
import { MessagesShardUnavailable, nodeOf, personOwner, shardOf } from "./messagesShardClient"
import { Message as ChatRow } from "./schema"

// The browser's replica of a conversation's shard, end to end with nothing replaced: a TanStack DB collection over
// `ShardClient`, over the HTTP transport, over ChatApi's real route (worker/chat/MessagesShardRoutes.ts `dispatch`),
// over the real shard and its SQLite (src/test/messagesShardHost.ts). Faults are the network's, injected at `fetch`.

const conversation = "3f2b8c1e-5d4a-4b7e-9c1d-2a6f0e8b7c5d"
const elsewhere = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
const ORIGIN = "https://smithers.example"
const shard = shardOf(conversation)
const ADA = personOwner("ada")
const BOB = personOwner("bob")
const files = tempDirectory("messages-shard-client-")

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(program))

const httpOf = (host: ShardHost, actor: Actor | null) =>
  Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, host.fetchAs(actor)))

/** A device's replica: `owner`'s node on `device`, signed in as `actor` (signed out with `null`). */
const open = (
  host: ShardHost,
  actor: Actor | null,
  node: string,
  over: Partial<MessagesShard.ReplicaOptions> = {},
) =>
  Effect.gen(function* () {
    const transport = yield* MessagesShardClient.make({ origin: ORIGIN, conversationId: conversation, within: "2 seconds" })
      .pipe(Effect.provide(httpOf(host, actor)))
    return yield* MessagesShard.make({
      conversationId: conversation,
      node,
      transport,
      retry: Schedule.spaced("5 millis"),
      ...over,
    })
  })

const row = (id: string, author: string, body = id): ShardMessage => ({ id, author, body, status: "posted", hubSeq: 0 })

/** The collection's rows as the shard's reducer holds them, without TanStack DB's own `$` fields. */
const rowsOf = (replica: MessagesShard.MessagesShardReplica) =>
  Effect.map(replica.messages.toArray, (rows) =>
    rows.map(({ id, author, body, status, hubSeq }): ShardMessage => ({ id, author, body, status, hubSeq })))

const eventually = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    while (!(yield* check)) yield* Effect.sleep(1)
  }).pipe(Effect.timeout(5_000))

const stateIs = (replica: MessagesShard.MessagesShardReplica, state: MessagesShard.MessagesShardStatus["state"]) =>
  eventually(Effect.map(SubscriptionRef.get(replica.status), (now) => now.state === state))

/** Why a write rolled back: TanStack DB and `persisted` wrap the handler's failure. */
const failureOf = (transaction: { readonly persisted: Effect.Effect<void, unknown> }) =>
  Effect.map(Effect.flip(transaction.persisted), (failed) => {
    let error: unknown = failed
    while (
      !(error instanceof MessagesWriteRefused) && !(error instanceof MessagesShardUnavailable) &&
      !(error instanceof ShardProtocol.ShardError) && !(error instanceof JournalCollection.JournalStopped) &&
      error instanceof Error && error.cause !== undefined
    ) error = error.cause
    return error
  })

/** Posts `ids` from `replica`, one settled write after another. */
const post = (replica: MessagesShard.MessagesShardReplica, author: string, ids: ReadonlyArray<string>) =>
  Effect.forEach(ids, (id) => Effect.flatMap(replica.messages.insert(row(id, author)), (write) => write.persisted), {
    discard: true,
  })

const submits = (host: ShardHost) => host.requests.filter((request) => request.endsWith("/submit")).length
const pullLine = (after: number, limit = 256) =>
  `GET /api/conversations/${conversation}/messages/pull?${
    ShardProtocol.pullQuery({ version: 2, shard, epoch: 0, after, limit })
  }`
const snapshotLine = `GET /api/conversations/${conversation}/messages/snapshot?shard=conv%3A${conversation}`

/** A gateway that rewrites a JSON answer. */
const rewrite = (change: (body: Record<string, unknown>) => unknown) => async (answer: Response) =>
  Response.json(change(await answer.json() as Record<string, unknown>))

test("a write shows at once, the real shard sequences it, and another person's replica reads it", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    const phone = yield* open(host, bob, nodeOf(BOB, "phone"))
    expect(yield* SubscriptionRef.get(laptop.status)).toEqual({ state: "pending", through: 0 })
    expect(yield* rowsOf(laptop)).toEqual([])

    const posted = yield* laptop.messages.insert(row("m1", ADA, "hello"))
    // Optimistic: shown before the shard has answered, with no `hubSeq` of its own.
    expect(Option.getOrThrow(yield* laptop.messages.get("m1"))).toMatchObject(row("m1", ADA, "hello"))
    expect(yield* laptop.messages.isSynced("m1")).toBe(false)
    yield* posted.persisted
    expect(yield* rowsOf(laptop)).toEqual([{ ...row("m1", ADA, "hello"), hubSeq: 1 }])
    expect(yield* laptop.messages.isSynced("m1")).toBe(true)
    expect(yield* SubscriptionRef.get(laptop.status)).toEqual({ state: "ok", through: 1 })
    expect(yield* laptop.state).toMatchObject({ applied: 1, nextCommand: 1, outbox: [] })

    expect(yield* phone.resume).toEqual({ shard, epoch: 0, seq: 1 })
    yield* phone.messages.awaitRow((message) => message.id === "m1", "2 seconds")

    // A status moves as its own command, and only the status.
    const moved = yield* laptop.messages.update("m1", (draft) => void (draft.status = "streaming"))
    yield* moved.persisted
    yield* phone.resume
    yield* phone.messages.awaitRow((message) => message.status === "streaming", "2 seconds")
    const expected = [{ id: "m1", author: ADA, body: "hello", status: "streaming", hubSeq: 1 }]
    expect(yield* rowsOf(phone)).toEqual(expected)
    expect(yield* rowsOf(laptop)).toEqual(expected)

    // Both replicas hold what the shard's own reducer holds, byte for byte.
    const hub = yield* host.state(conversation)
    expect(hub.chat.messages).toEqual(expected)
    expect(canonicalHash(yield* laptop.chat)).toBe(hub.hash)
    expect(canonicalHash(yield* phone.chat)).toBe(hub.hash)
    expect(laptop).toMatchObject({ conversationId: conversation, shard })
  })))

test("writes made offline stay shown and queued, and are sent once each when the network returns", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    host.fail("offline", "", Number.POSITIVE_INFINITY)
    const first = yield* laptop.messages.insert(row("m1", ADA))
    const second = yield* laptop.messages.insert(row("m2", ADA))
    yield* stateIs(laptop, "failing")
    yield* eventually(Effect.map(laptop.state, (state) => state.outbox.length === 2))
    // Deterministic keys: this node, counting up in its store.
    expect((yield* laptop.state).outbox.map((command) => command.key)).toEqual([
      [nodeOf(ADA, "laptop"), "0"],
      [nodeOf(ADA, "laptop"), "1"],
    ])
    expect((yield* rowsOf(laptop)).map((message) => message.id).sort()).toEqual(["m1", "m2"])
    expect(yield* laptop.messages.isSynced("m1")).toBe(false)
    // Retry while still offline fails as the network does, and loses nothing.
    expect(yield* Effect.flip(laptop.resume)).toEqual(
      new MessagesShardUnavailable({ request: "submit", reason: "unreachable" }),
    )
    expect((yield* host.head(conversation)).seq).toBe(0)

    host.heal()
    yield* first.persisted
    yield* second.persisted
    expect(yield* rowsOf(laptop)).toEqual([
      { ...row("m1", ADA), hubSeq: 1 },
      { ...row("m2", ADA), hubSeq: 2 },
    ])
    expect(yield* SubscriptionRef.get(laptop.status)).toEqual({ state: "ok", through: 2 })
    expect((yield* laptop.state).outbox).toEqual([])
    expect((yield* host.head(conversation)).seq).toBe(2)
  })))

test("a command whose answer was lost is sent again and answered from its receipt: one entry, one row", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    host.fail("lost", "/submit", 3)
    yield* post(laptop, ADA, ["m1"])
    expect(submits(host)).toBe(4)
    expect((yield* host.head(conversation)).seq).toBe(1)
    expect(yield* rowsOf(laptop)).toEqual([{ ...row("m1", ADA), hubSeq: 1 }])

    // The same message from the person's second device, under that device's own key: sequenced, and still one row.
    const tablet = yield* open(host, ada, nodeOf(ADA, "tablet"))
    yield* post(tablet, ADA, ["m1"])
    expect((yield* host.head(conversation)).seq).toBe(2)
    expect(yield* rowsOf(tablet)).toEqual([{ ...row("m1", ADA), hubSeq: 1 }])
    expect((yield* host.state(conversation)).chat.messages).toHaveLength(1)
  })))

test("a reconnect resumes by Pull after the cursor, through a restart of the object: no snapshot, no refetch", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost({ path: (id) => join(files, `${id}.sqlite`) })
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    const phone = yield* open(host, bob, nodeOf(BOB, "phone"))
    yield* post(laptop, ADA, ["m1", "m2", "m3"])
    // The object restarts while the laptop is away, and another person writes.
    yield* host.restart
    yield* post(phone, BOB, ["m4", "m5"])
    host.requests.length = 0
    expect(yield* laptop.resume).toEqual({ shard, epoch: 0, seq: 5 })
    expect(host.requests).toEqual([pullLine(3)])
    yield* laptop.messages.awaitRow((message) => message.id === "m5", "2 seconds")
    expect((yield* rowsOf(laptop)).map((message) => [message.id, message.hubSeq])).toEqual([
      ["m1", 1], ["m2", 2], ["m3", 3], ["m4", 4], ["m5", 5],
    ])
    // Nothing new: one request, no entries, nothing applied twice.
    host.requests.length = 0
    expect(yield* laptop.resume).toEqual({ shard, epoch: 0, seq: 5 })
    expect(host.requests).toEqual([pullLine(5)])
    expect(canonicalHash(yield* laptop.chat)).toBe((yield* host.state(conversation)).hash)
  })))

test("after compaction a device with a cursor pulls on, and a new or lost one rebuilds from the snapshot", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    yield* post(laptop, ADA, ["m1", "m2", "m3"])
    expect(yield* host.compact(conversation)).toEqual({ shard, epoch: 0, seq: 3 })
    yield* post(laptop, ADA, ["m4"])
    const hub = yield* host.state(conversation)

    // The laptop already holds the snapshot's cursor: compaction cost it nothing.
    expect(host.requests).not.toContain(snapshotLine)

    // A new device has no cursor: the snapshot, then the one entry after it, never seq 1.
    const tablet = yield* open(host, ada, nodeOf(ADA, "tablet"))
    host.requests.length = 0
    expect(yield* tablet.resume).toEqual({ shard, epoch: 0, seq: 4 })
    expect(host.requests).toEqual([pullLine(0), snapshotLine, pullLine(3)])
    yield* tablet.messages.awaitRow((message) => message.id === "m4", "2 seconds")
    expect(yield* rowsOf(tablet)).toEqual(hub.chat.messages)
    expect(canonicalHash(yield* tablet.chat)).toBe(hub.hash)

    // A device told to resync while it shows rows replaces them all with the snapshot's: no row twice, none left over.
    host.fail(rewrite(() => ({ _tag: "Resync", shard, epoch: 0, snapshotSeq: 3 })), "/pull")
    yield* laptop.resume
    yield* eventually(Effect.map(SubscriptionRef.get(laptop.status), (now) => now.through === 4))
    expect(yield* rowsOf(laptop)).toEqual(hub.chat.messages)
    expect(canonicalHash(yield* laptop.chat)).toBe(hub.hash)

    // A device whose store names a history this shard never had (another epoch, a cursor past the head).
    const store = ShardClient.memoryStore()
    yield* store.modify((state) => [undefined, { ...state, epoch: 7, applied: 9 }])
    const restored = yield* open(host, ada, nodeOf(ADA, "restored"), { store })
    // Its write is told the shard's epoch and resubmitted under it; its read is rebuilt from the snapshot.
    yield* post(restored, ADA, ["m5"])
    expect(yield* restored.state).toMatchObject({ epoch: 0, applied: 5, outbox: [] })
    expect(yield* rowsOf(restored)).toEqual((yield* host.state(conversation)).chat.messages)
  })))

test("a cursor outside a shard that never compacted rebuilds from the empty snapshot", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    yield* post(yield* open(host, ada, nodeOf(ADA, "laptop")), ADA, ["m1"])
    const store = ShardClient.memoryStore()
    yield* store.modify((state) => [undefined, { ...state, applied: 9 }])
    const lost = yield* open(host, ada, nodeOf(ADA, "lost"), { store })
    host.requests.length = 0
    expect(yield* lost.resume).toEqual({ shard, epoch: 0, seq: 1 })
    expect(host.requests).toEqual([pullLine(9), snapshotLine, pullLine(0)])
    yield* lost.messages.awaitRow((message) => message.id === "m1", "2 seconds")
    expect(yield* rowsOf(lost)).toEqual([{ ...row("m1", ADA), hubSeq: 1 }])
  })))

test("a write the reducer refuses rolls back with its reason, once, and leaves the outbox empty", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    yield* post(laptop, ADA, ["m1"])

    // A second device that has not read `m1` posts other text under its id.
    const store = ShardClient.memoryStore()
    // A refusal an earlier write of this store never collected stays where it is.
    const foreign = { _tag: "Refused" as const, key: ["elsewhere", "0"] as const, reason: "message_missing" }
    yield* store.modify((state) => [undefined, { ...state, terminalFailures: [foreign] }])
    const tablet = yield* open(host, ada, nodeOf(ADA, "tablet"), { store })
    const conflicting = yield* tablet.messages.insert(row("m1", ADA, "other text"))
    expect(yield* failureOf(conflicting)).toEqual(
      new MessagesWriteRefused({ reason: "refused", detail: "message_conflict" }),
    )
    // The write's own pull delivered the message that stands.
    yield* tablet.messages.awaitRow((message) => message.hubSeq === 1, "2 seconds")
    expect(yield* rowsOf(tablet)).toEqual([{ ...row("m1", ADA), hubSeq: 1 }])
    expect(yield* tablet.state).toMatchObject({ outbox: [], terminalFailures: [foreign] })

    // A status that would overwrite a terminal one.
    yield* (yield* laptop.messages.update("m1", (draft) => void (draft.status = "complete"))).persisted
    const stale = yield* tablet.messages.update("m1", (draft) => void (draft.status = "streaming"))
    expect(yield* failureOf(stale)).toEqual(new MessagesWriteRefused({ reason: "refused", detail: "terminal_status" }))
    yield* tablet.messages.awaitRow((message) => message.status === "complete", "2 seconds")
    expect((yield* tablet.state).terminalFailures).toEqual([foreign])
    expect((yield* host.head(conversation)).seq).toBe(2)

    // With nothing else recorded, the store keeps no refusals at all.
    const phone = yield* open(host, ada, nodeOf(ADA, "phone"))
    expect(yield* failureOf(yield* phone.messages.insert(row("m1", ADA, "third text")))).toEqual(
      new MessagesWriteRefused({ reason: "refused", detail: "message_conflict" }),
    )
    expect(yield* phone.state).not.toHaveProperty("terminalFailures")
  })))

test("a node used with a second store reuses a key for other content, and the shard refuses the collision", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    yield* post(yield* open(host, ada, nodeOf(ADA, "laptop")), ADA, ["m1"])
    // The same node after a reload that lost its store: its ids count from zero again.
    const reloaded = yield* open(host, ada, nodeOf(ADA, "laptop"))
    const collided = yield* reloaded.messages.insert(row("m2", ADA))
    expect(yield* failureOf(collided)).toEqual(new MessagesWriteRefused({ reason: "idempotency_conflict" }))
    expect(yield* reloaded.messages.get("m2")).toEqual(Option.none())
    expect(yield* reloaded.state).toMatchObject({ outbox: [] })
    expect(yield* reloaded.state).not.toHaveProperty("terminalFailures")
    expect((yield* host.state(conversation)).chat.messages.map((message) => message.id)).toEqual(["m1"])
  })))

test("a write ChatApi decides against rolls back and is never sent again; a retryable answer is retried", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    // Signed out.
    const visitor = yield* open(host, null, nodeOf(ADA, "kiosk"))
    expect(yield* failureOf(yield* visitor.messages.insert(row("m1", ADA)))).toEqual(
      new MessagesShardUnavailable({ request: "submit", reason: "refused", status: 401 }),
    )
    expect(yield* rowsOf(visitor)).toEqual([])
    expect((yield* visitor.state).outbox).toEqual([])
    expect((yield* SubscriptionRef.get(visitor.status)).state).toBe("refused")
    const sent = submits(host)
    expect(yield* Effect.flip(visitor.resume)).toMatchObject({ request: "pull", status: 401 })
    expect(submits(host)).toBe(sent)

    // May view, may not ask: reads are answered, the write is refused.
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    host.grant((_, id) => branchOf(id, { access: "view" }))
    expect(yield* laptop.resume).toEqual({ shard, epoch: 0, seq: 0 })
    expect(yield* failureOf(yield* laptop.messages.insert(row("m1", ADA)))).toMatchObject({ reason: "refused", status: 403 })
    // Another person's name on the message: the shard's own refusal, named by the Worker.
    host.grant((_, id) => branchOf(id))
    expect(yield* failureOf(yield* laptop.messages.insert(row("m1", BOB)))).toEqual(
      new MessagesShardUnavailable({ request: "submit", reason: "refused", status: 403, refusal: "author" }),
    )
    // A conversation that is not there.
    host.grant(() => undefined)
    expect(yield* Effect.flip(laptop.resume)).toMatchObject({ request: "pull", status: 404 })
    expect((yield* laptop.state).outbox).toEqual([])
    expect((yield* host.head(conversation)).seq).toBe(0)

    // A gateway's 503s, and a 401 the page found was the same person's session: sent again until taken.
    host.grant((_, id) => branchOf(id))
    host.fail({ status: 503 }, "", 2)
    host.fail({ status: 401, sameSession: true }, "/submit")
    yield* post(laptop, ADA, ["m1"])
    expect(yield* rowsOf(laptop)).toEqual([{ ...row("m1", ADA), hubSeq: 1 }])
  })))

test("a write the reducer has no command for is refused before anything is queued", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    yield* post(laptop, ADA, ["m1"])
    host.requests.length = 0
    const unsupported = (detail: string) => new MessagesWriteRefused({ reason: "unsupported", detail })
    expect(yield* failureOf(yield* laptop.messages.delete("m1"))).toEqual(unsupported("delete"))
    expect(yield* failureOf(yield* laptop.messages.insert({ ...row("m2", ADA), status: "complete" })))
      .toEqual(unsupported("insert_status"))
    expect(yield* failureOf(yield* laptop.messages.update("m1", (draft) => void (draft.body = "edited"))))
      .toEqual(unsupported("update"))
    expect(yield* failureOf(yield* laptop.messages.update("m1", (draft) => void (draft.author = BOB))))
      .toEqual(unsupported("update"))
    // A row the shard has not sequenced yet has no status to move.
    host.fail("offline", "", Number.POSITIVE_INFINITY)
    const queued = yield* laptop.messages.insert(row("m3", ADA))
    yield* stateIs(laptop, "failing")
    expect(yield* failureOf(yield* laptop.messages.update("m3", (draft) => void (draft.status = "streaming"))))
      .toEqual(unsupported("update"))
    host.heal()
    yield* queued.persisted
    expect(yield* rowsOf(laptop)).toEqual([{ ...row("m1", ADA), hubSeq: 1 }, { ...row("m3", ADA), hubSeq: 2 }])
    expect((yield* host.head(conversation)).seq).toBe(2)
  })))

test("a post carries what it says about the message; an update patches its metadata, then moves its status", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    const phone = yield* open(host, bob, nodeOf(BOB, "phone"))
    const said = { role: "assistant", questionId: "m0", position: 3, createdAt: "2026-11-25 10:00:00+00" } as const
    const step = (id: string, status: "running" | "done") => ({ id, kind: "step", flow: "chat/copy", status }) as const
    const stored = Effect.map(host.state(conversation), (hub) => hub.chat.messages[0])
    const head = Effect.map(host.head(conversation), (position) => position.seq)

    // An insert with metadata is one command and one entry: the post carries it.
    host.requests.length = 0
    yield* (yield* laptop.messages.insert({ ...row("a1", ADA, ""), ...said, modelId: "m-large" })).persisted
    const posted = { id: "a1", author: ADA, body: "", status: "posted", hubSeq: 1, ...said, modelId: "m-large" }
    expect(yield* stored).toEqual(posted)
    expect(yield* head).toBe(1)
    expect(submits(host)).toBe(1)
    expect(yield* host.events(conversation, 0)).toEqual([
      [{ _tag: "MessagePosted", id: "a1", author: ADA, body: "", ...said, modelId: "m-large" }],
    ])

    // Metadata and status in one write: the patch first, only with what changed, then the status.
    yield* (yield* laptop.messages.update("a1", (draft) => {
      draft.parts = [step("0.0", "running")]
      draft.inputTokens = 5
      draft.status = "streaming"
    })).persisted
    expect(yield* head).toBe(3)
    expect(yield* host.events(conversation, 1)).toEqual([
      [{ _tag: "MessageMetadataUpdated", id: "a1", parts: [step("0.0", "running")], inputTokens: 5 }],
      [{ _tag: "MessageStatusUpdated", id: "a1", status: "streaming" }],
    ])

    // Metadata alone is one command, and what did not change is not sent again.
    yield* (yield* laptop.messages.update("a1", (draft) => {
      draft.parts = [step("0.0", "done")]
      draft.outputTokens = 9
    })).persisted
    expect(yield* head).toBe(4)
    expect(yield* host.events(conversation, 3)).toEqual([
      [{ _tag: "MessageMetadataUpdated", id: "a1", parts: [step("0.0", "done")], outputTokens: 9 }],
    ])

    // How an answer ended, and its end, in one write: the run metadata lands before the status freezes it.
    yield* (yield* laptop.messages.update("a1", (draft) => {
      draft.failure = "empty"
      draft.stopReason = "end_turn"
      draft.status = "failed"
    })).persisted
    expect(yield* head).toBe(6)
    const ended = {
      ...posted,
      status: "failed",
      parts: [step("0.0", "done")],
      inputTokens: 5,
      outputTokens: 9,
      failure: "empty",
      stopReason: "end_turn",
    }
    expect(yield* stored).toEqual(ended)

    // Once it has ended its run metadata is frozen, and the refused write rolls back.
    const late = yield* laptop.messages.update("a1", (draft) => void (draft.inputTokens = 6))
    expect(yield* failureOf(late)).toEqual(new MessagesWriteRefused({ reason: "refused", detail: "terminal_metadata" }))
    expect(Option.getOrThrow(yield* laptop.messages.get("a1"))).toMatchObject({ inputTokens: 5 })
    // A note is still taken.
    yield* (yield* laptop.messages.update("a1", (draft) => {
      draft.summary = "nothing came back"
      draft.updatedAt = "2026-11-25 10:00:09+00"
    })).persisted
    expect(yield* head).toBe(7)

    // The reducer has no command that changes what the post said, and the collection takes no field away.
    const unsupported = new MessagesWriteRefused({ reason: "unsupported", detail: "update" })
    expect((yield* Effect.exit(laptop.messages.update("a1", (draft) => void delete draft.summary)))._tag).toBe("Failure")
    expect(yield* failureOf(yield* laptop.messages.update("a1", (draft) => void (draft.role = "user")))).toEqual(unsupported)
    expect(yield* failureOf(yield* laptop.messages.update("a1", (draft) => void (draft.position = 4)))).toEqual(unsupported)
    expect(yield* head).toBe(7)

    // Another person's replica folds the same message, and both show it as the row chat's pages read.
    yield* phone.resume
    const noted = { ...ended, summary: "nothing came back", updatedAt: "2026-11-25 10:00:09+00" }
    expect((yield* phone.chat).messages).toEqual([noted])
    expect(canonicalHash(yield* phone.chat)).toBe((yield* host.state(conversation)).hash)
    expect(canonicalHash(yield* laptop.chat)).toBe((yield* host.state(conversation)).hash)
    expect(MessagesShard.rowsOf(yield* phone.chat, { conversationId: conversation })).toEqual([{
      id: "a1",
      role: "assistant",
      text: "",
      status: "failed",
      questionId: "m0",
      failure: "empty",
      modelId: "m-large",
      stopReason: "end_turn",
      inputTokens: 5,
      outputTokens: 9,
      position: 3,
      createdAt: "2026-11-25 10:00:00+00",
      updatedAt: "2026-11-25 10:00:09+00",
      conversationId: conversation,
      parts: [step("0.0", "done")],
      summary: "nothing came back",
      summaryRevision: null,
      phase: null,
      arc: null,
    }])
  })))

test("a shard message maps to the row chat reads, with Postgres's defaults for what it lacks", () => {
  const decode = Schema.decodeUnknownSync(ChatRow)
  const context = { conversationId: conversation }
  // A message from before the reducer carried the fields: a person's is a question, at the place it was sequenced.
  const bare = MessagesShard.rowOf({ ...row("m1", ADA, "hello"), hubSeq: 4 }, context)
  expect(bare).toEqual({
    id: "m1",
    role: "user",
    text: "hello",
    status: "done",
    questionId: null,
    failure: null,
    modelId: null,
    stopReason: null,
    inputTokens: null,
    outputTokens: null,
    position: 4,
    createdAt: "",
    updatedAt: "",
    conversationId: conversation,
    summary: null,
    summaryRevision: null,
    phase: null,
    arc: null,
  })
  expect(bare).not.toHaveProperty("parts")
  expect(decode(bare)).toEqual(bare)
  // A run's is an answer. A person's post may say it is one too.
  expect(MessagesShard.rowOf(row("a1", "agent:ada:run-1:run-1"), context)).toMatchObject({ role: "assistant", position: 0 })
  expect(MessagesShard.rowOf({ ...row("m2", ADA), role: "assistant" }, context).role).toBe("assistant")
  expect(MessagesShard.rowOf({ ...row("m2", ADA), role: "user" }, context).role).toBe("user")
  // A message whose verified author is not a person never reads as a person's, whatever its post says: not a run's,
  // and not one whose name only resembles a person's.
  for (const author of ["agent:ada:run-1:run-1", "flow:ada:summary:1", "ada", "Person:ada", "xperson:ada", " person:ada", ""]) {
    expect(MessagesShard.rowOf({ ...row("a1", author), role: "user" }, context).role, author).toBe("assistant")
    expect(MessagesShard.rowsOf({ messages: [{ ...row("a1", author), role: "user" }] }, context)[0]!.role, author).toBe("assistant")
  }
  expect(MessagesShard.rowOf({ ...row("m2", ADA), createdAt: "t0" }, context)).toMatchObject({ createdAt: "t0", updatedAt: "t0" })
  expect((["posted", "streaming", "complete", "failed"] as const).map((status) =>
    MessagesShard.rowOf({ ...row("m3", ADA), status }, context).status
  )).toEqual(["done", "streaming", "done", "failed"])

  // Every field the reducer carries reaches its column.
  const full: ShardMessage = {
    id: "a2",
    author: "agent:ada:run-1:run-1",
    body: "an answer",
    status: "complete",
    hubSeq: 9,
    role: "assistant",
    questionId: "m1",
    position: 0,
    createdAt: "t0",
    parts: [{ id: "0.0", kind: "step", flow: "chat/copy", status: "done" }],
    failure: "unfinished",
    modelId: "m-large",
    stopReason: "end_turn",
    inputTokens: 0,
    outputTokens: 12,
    summary: "a summary",
    summaryRevision: "rev-1",
    phase: "{\"title\":\"plan\"}",
    arc: "{\"title\":\"build\"}",
    updatedAt: "t1",
  }
  const { author: _, body, hubSeq: __, status: ___, ...columns } = full
  const mapped = MessagesShard.rowOf(full, context)
  expect(mapped).toEqual({ ...columns, text: body, status: "done", conversationId: conversation })
  expect(decode(mapped)).toEqual(mapped)
  expect(MessagesShard.rowsOf({ messages: [full, row("m1", ADA)] }, context).map((mapped) => mapped.id)).toEqual(["a2", "m1"])
  expect(MessagesShard.rowsOf(emptyChat, context)).toEqual([])
})

test("entries or a snapshot the reducer cannot fold fail the pull and move nothing; the next pull recovers", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    yield* post(yield* open(host, ada, nodeOf(ADA, "laptop")), ADA, ["m1"])
    const phone = yield* open(host, bob, nodeOf(BOB, "phone"))
    const unreadable = new MessagesShardUnavailable({ request: "pull", reason: "invalid_response" })

    host.fail(rewrite((page) => ({
      ...page,
      entries: (page["entries"] as ReadonlyArray<object>).map((entry) => ({ ...entry, events: [{ _tag: "Unknown" }] })),
    })), "/pull")
    expect(yield* Effect.flip(phone.resume)).toEqual(unreadable)
    expect(yield* SubscriptionRef.get(phone.status)).toEqual({ state: "failing", through: 0 })
    expect(yield* phone.state).toMatchObject({ applied: 0 })

    host.fail(rewrite(() => ({ _tag: "Resync", shard, epoch: 0, snapshotSeq: 0 })), "/pull")
    host.fail(rewrite((snapshot) => ({ ...snapshot, state: { chat: "not a chat" } })), "/snapshot")
    expect(yield* Effect.flip(phone.resume)).toEqual(unreadable)
    expect(yield* rowsOf(phone)).toEqual([])
    expect(yield* phone.chat).toEqual(emptyChat)

    expect(yield* phone.resume).toEqual({ shard, epoch: 0, seq: 1 })
    yield* phone.messages.awaitRow((message) => message.id === "m1", "2 seconds")
    expect(yield* SubscriptionRef.get(phone.status)).toEqual({ state: "ok", through: 1 })
  })))

test("an answer that names another shard is refused by the protocol, and a write waiting on it rolls back", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    const misrouted = rewrite((page) => ({ ...page, shard: shardOf(elsewhere) }))
    host.fail(misrouted, "/pull")
    expect(yield* Effect.flip(laptop.resume)).toMatchObject({ _tag: "@smthrs/sync/ShardError", reason: "wrong_shard" })
    expect((yield* SubscriptionRef.get(laptop.status)).state).toBe("refused")

    // The shard took the write; only its read was misrouted. The write is not retried, and the next pull shows it.
    host.fail(misrouted, "/pull")
    const posted = yield* laptop.messages.insert(row("m1", ADA))
    expect(yield* failureOf(posted)).toMatchObject({ _tag: "@smthrs/sync/ShardError", reason: "wrong_shard" })
    expect(submits(host)).toBe(1)
    expect(yield* rowsOf(laptop)).toEqual([])
    expect(yield* laptop.resume).toEqual({ shard, epoch: 0, seq: 1 })
    yield* laptop.messages.awaitRow((message) => message.id === "m1", "2 seconds")
    expect(yield* laptop.messages.isSynced("m1")).toBe(true)
  })))

test("a following replica reads what others write on its own, through requests that fail", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    host.fail("offline", "/pull", 3)
    const phone = yield* open(host, bob, nodeOf(BOB, "phone"), { follow: "5 millis", limit: 1 })
    yield* post(laptop, ADA, ["m1", "m2"])
    yield* phone.messages.awaitRow((message) => message.id === "m2", "5 seconds")
    expect(yield* rowsOf(phone)).toEqual([{ ...row("m1", ADA), hubSeq: 1 }, { ...row("m2", ADA), hubSeq: 2 }])
    // One entry a page, as `limit` asks.
    expect(host.requests).toContain(pullLine(1, 1))
  })))

test("a write queued when its tab closes rolls back there and is sent by the next tab over the same store", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const store = ShardClient.memoryStore()
    const tab = yield* Scope.make()
    const first = yield* open(host, ada, nodeOf(ADA, "laptop"), { store }).pipe(Scope.provide(tab))
    host.fail("offline", "", Number.POSITIVE_INFINITY)
    const queued = yield* first.messages.insert(row("m1", ADA))
    yield* stateIs(first, "failing")
    yield* Scope.close(tab, Exit.void)
    expect(yield* failureOf(queued)).toMatchObject({ _tag: "JournalStopped", reason: "closed" })
    expect((yield* store.load).outbox).toHaveLength(1)
    expect((yield* host.head(conversation)).seq).toBe(0)

    host.heal()
    const next = yield* open(host, ada, nodeOf(ADA, "laptop"), { store })
    expect(yield* rowsOf(next)).toEqual([])
    expect(yield* next.resume).toEqual({ shard, epoch: 0, seq: 1 })
    yield* next.messages.awaitRow((message) => message.id === "m1", "2 seconds")
    // Its ids go on from the store's count: the next write takes a new key.
    yield* post(next, ADA, ["m2"])
    expect((yield* host.head(conversation)).seq).toBe(2)
  })))

test("the browser folds deliveries exactly as the shard does", () => {
  const entry = (seq: number, events: ReadonlyArray<unknown>) =>
    ({ seq, epoch: 0, key: ["n", String(seq)] as const, stream: shard, events: events as never })
  const deliveries: ReadonlyArray<ShardClient.Delivery> = [
    {
      _tag: "Entries",
      through: { shard, epoch: 0, seq: 3 },
      entries: [
        entry(1, [{ _tag: "MessagePosted", id: "m1", author: ADA, body: "one" }]),
        entry(2, []),
        entry(3, [{ _tag: "MessageStatusUpdated", id: "m1", status: "complete" }]),
      ],
    },
    {
      _tag: "Entries",
      through: { shard, epoch: 0, seq: 5 },
      entries: [
        entry(4, [{ _tag: "MessagePosted", id: "m2", author: ADA, body: "two", role: "user", position: 2, createdAt: "t0" }]),
        entry(5, [{ _tag: "MessageMetadataUpdated", id: "m2", summary: "a summary", inputTokens: 3 }]),
      ],
    },
    { _tag: "Reset", snapshot: { position: { shard, epoch: 0, seq: 0 }, state: null } },
    {
      _tag: "Reset",
      snapshot: {
        position: { shard, epoch: 0, seq: 4 },
        state: { chat: { messages: [{ id: "m9", author: BOB, body: "nine", status: "posted", hubSeq: 4 }] } },
      },
    },
  ]
  let mine = emptyChat
  let theirs = emptyChat
  for (const delivery of deliveries) {
    const before = mine
    mine = MessagesShard.fold(mine, delivery)
    theirs = WorkerShard.apply(theirs, delivery)
    expect(mine).toEqual(theirs)
    if (delivery._tag === "Entries") {
      // The message the delivery posts, and then moves: an insert from before it, an update from between.
      const posted = mine.messages.at(-1)
      expect(MessagesShard.changesBetween(before, mine)).toEqual([{ type: "insert", value: posted }])
      const moved = MessagesShard.fold(before, { ...delivery, entries: delivery.entries.slice(0, 1) })
      expect(MessagesShard.changesBetween(moved, mine)).toEqual([{ type: "update", value: posted }])
      expect(MessagesShard.changesBetween(mine, mine)).toEqual([])
    }
  }
})

test("MessagesShards opens one replica a conversation, over the layer's HttpClient, with the tab's node", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const stores = new Map<string, ShardClient.ClientStore>()
    const configured = MessagesShards.layer({
      origin: ORIGIN,
      within: "2 seconds",
      owner: ADA,
      device: "laptop",
      retry: Schedule.spaced("5 millis"),
      follow: "5 millis",
      limit: 2,
      storeFor: (id) => {
        const store = ShardClient.memoryStore()
        stores.set(id, store)
        return store
      },
    }).pipe(Layer.provide(httpOf(host, ada)))
    const defaults = MessagesShards.layer({ origin: ORIGIN, within: "2 seconds", owner: BOB, device: "phone" })
      .pipe(Layer.provide(httpOf(host, bob)))

    const laptop = yield* Effect.gen(function* () {
      const shards = Context.get(yield* Layer.build(configured), MessagesShards)
      expect(shards.opened(conversation)).toBeUndefined()
      // Two callers, two spellings of one UUID: one replica, one store.
      const [one, two] = yield* Effect.all([shards.open(conversation.toUpperCase()), shards.open(conversation)], {
        concurrency: "unbounded",
      })
      expect(one).toBe(two)
      expect(yield* shards.open(conversation)).toBe(one)
      expect(shards.opened(conversation.toUpperCase())).toBe(one)
      expect(shards.opened(elsewhere)).toBeUndefined()
      expect([...stores.keys()]).toEqual([conversation])
      // Another conversation is another shard, with its own replica and store.
      const other = yield* shards.open(elsewhere)
      expect(other.shard).toBe(shardOf(elsewhere))
      expect([...stores.keys()]).toEqual([conversation, elsewhere])
      return one
    })

    const phone = yield* Context.get(yield* Layer.build(defaults), MessagesShards).open(conversation)
    yield* post(phone, BOB, ["m1", "m2", "m3"])
    expect((yield* phone.state).outbox).toEqual([])
    // The configured replica follows on its own, in pages of two, and writes from the configured node.
    yield* laptop.messages.awaitRow((message) => message.id === "m3", "5 seconds")
    expect(host.requests).toContain(pullLine(0, 2))
    yield* post(laptop, ADA, ["m4"])
    const page = yield* (yield* MessagesShardClient.make({ origin: ORIGIN, conversationId: conversation, within: "2 seconds" })
      .pipe(Effect.provide(httpOf(host, ada)))).pull({ version: 2, shard, epoch: 0, after: 3, limit: 1 })
    expect(page).toMatchObject({ entries: [{ key: [nodeOf(ADA, "laptop"), "0"] }] })
    expect((yield* stores.get(conversation)!.load).nextCommand).toBe(1)
  })))

test("a refused insert never changes the message that stands: two devices, one author, one id", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost({ path: (id) => join(files, `conflict-${id}.sqlite`) })
    const said = { role: "user", position: 1, createdAt: "2026-11-25 10:00:00+00" } as const
    const first: ShardMessage = { ...row("m1", ADA, "the first draft"), ...said, summary: "the first summary", updatedAt: "t1" }
    const second: ShardMessage = { ...row("m1", ADA, "the second draft"), ...said, summary: "the second summary", updatedAt: "t2" }
    const stands = { ...first, hubSeq: 1 }

    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    yield* (yield* laptop.messages.insert(first)).persisted
    // The same person's second device, which has not read `m1`, inserts another draft under its id.
    const tablet = yield* open(host, ada, nodeOf(ADA, "tablet"))
    host.requests.length = 0
    const conflicting = yield* tablet.messages.insert(second)
    expect(yield* failureOf(conflicting)).toEqual(new MessagesWriteRefused({ reason: "refused", detail: "message_conflict" }))
    // One logical write is one command: there was no second submit to land on the first device's message.
    expect(submits(host)).toBe(1)
    expect(yield* tablet.state).toMatchObject({ outbox: [] })

    // SQLite, read by a fresh wake of the object and again after a restart: the first device's body and summary.
    expect((yield* host.state(conversation)).chat.messages).toEqual([stands])
    yield* host.restart
    expect((yield* host.state(conversation)).chat.messages).toEqual([stands])
    expect((yield* host.head(conversation)).seq).toBe(1)
    expect(yield* host.events(conversation, 0)).toEqual([[{
      _tag: "MessagePosted", id: "m1", author: ADA, body: "the first draft", ...said, summary: "the first summary", updatedAt: "t1",
    }]])
    // The refused device rolled back to the message that stands.
    yield* tablet.messages.awaitRow((message) => message.hubSeq === 1, "2 seconds")
    expect(Option.getOrThrow(yield* tablet.messages.get("m1"))).toMatchObject(stands)

    // The same body with another summary is refused too: a post never patches a message that exists.
    const phone = yield* open(host, ada, nodeOf(ADA, "phone"))
    const renoted = yield* phone.messages.insert({ ...first, summary: "the second summary" })
    expect(yield* failureOf(renoted)).toEqual(new MessagesWriteRefused({ reason: "refused", detail: "message_conflict" }))
    expect((yield* host.head(conversation)).seq).toBe(1)
    // The very same message from another device is the same post: its entry holds no event, and nothing changes.
    const watch = yield* open(host, ada, nodeOf(ADA, "watch"))
    yield* (yield* watch.messages.insert(first)).persisted
    expect(yield* host.events(conversation, 1)).toEqual([[]])
    expect((yield* host.state(conversation)).chat.messages).toEqual([stands])
    expect(canonicalHash(yield* laptop.chat)).toBe((yield* host.state(conversation)).hash)
  })))

test("an update's status is never sent after its metadata was refused", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const stored = Effect.map(host.state(conversation), (hub) => hub.chat.messages[0])
    yield* post(yield* open(host, ada, nodeOf(ADA, "laptop")), ADA, ["m1"])
    // The same node after a reload that lost its store: its first key names the post above, its second is free.
    const reloaded = yield* open(host, ada, nodeOf(ADA, "laptop"))
    yield* reloaded.resume
    yield* reloaded.messages.awaitRow((message) => message.id === "m1", "2 seconds")
    host.requests.length = 0
    const ending = yield* reloaded.messages.update("m1", (draft) => {
      draft.failure = "empty"
      draft.inputTokens = 5
      draft.status = "failed"
    })
    expect(yield* failureOf(ending)).toEqual(new MessagesWriteRefused({ reason: "idempotency_conflict" }))
    // The status would have been accepted under the free key, ending the message without how it ended, for good.
    expect(submits(host)).toBe(1)
    expect(yield* stored).toEqual({ ...row("m1", ADA), hubSeq: 1 })
    expect((yield* host.head(conversation)).seq).toBe(1)
    expect(yield* reloaded.state).toMatchObject({ outbox: [], nextCommand: 1 })
    expect(Option.getOrThrow(yield* reloaded.messages.get("m1"))).toMatchObject({ status: "posted" })

    // The reducer's own refusal of the metadata stops the write the same way.
    const tablet = yield* open(host, ada, nodeOf(ADA, "tablet"))
    yield* tablet.resume
    yield* tablet.messages.awaitRow((message) => message.id === "m1", "2 seconds")
    const phone = yield* open(host, ada, nodeOf(ADA, "phone"))
    yield* phone.resume
    yield* phone.messages.awaitRow((message) => message.id === "m1", "2 seconds")
    yield* (yield* phone.messages.update("m1", (draft) => void (draft.status = "complete"))).persisted
    host.requests.length = 0
    const stale = yield* tablet.messages.update("m1", (draft) => {
      draft.inputTokens = 6
      draft.status = "complete"
    })
    expect(yield* failureOf(stale)).toEqual(new MessagesWriteRefused({ reason: "refused", detail: "terminal_metadata" }))
    expect(submits(host)).toBe(1)
    expect(yield* stored).toEqual({ ...row("m1", ADA), status: "complete", hubSeq: 1 })
    expect((yield* host.head(conversation)).seq).toBe(2)
    expect(yield* tablet.state).toMatchObject({ outbox: [], nextCommand: 1 })
  })))

test("a replica of an id that is not a conversation's sends nothing, and its writes roll back", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const shards = Context.get(
      yield* Layer.build(
        MessagesShards.layer({ origin: ORIGIN, within: "2 seconds", owner: ADA, device: "laptop", retry: Schedule.spaced("5 millis") })
          .pipe(Layer.provide(httpOf(host, ada))),
      ),
      MessagesShards,
    )
    for (const id of ["../admin", `${conversation}/../../admin`, `${conversation}?foo=bar`]) {
      const replica = yield* shards.open(id)
      expect(yield* Effect.flip(replica.resume)).toMatchObject({ _tag: "MessagesShardUnavailable", reason: "invalid_target" })
      expect(yield* SubscriptionRef.get(replica.status)).toEqual({ state: "refused", through: 0 })
      const write = yield* replica.messages.insert(row("m1", ADA))
      expect(yield* failureOf(write)).toMatchObject({ _tag: "MessagesShardUnavailable", reason: "invalid_target" })
      expect(yield* replica.messages.get("m1")).toEqual(Option.none())
      expect(yield* replica.state).toMatchObject({ outbox: [] })
    }
    expect(host.requests).toEqual([])
  })))

test("a streamed answer extends its body, then its metadata, then its status, each only once the one before was taken", () =>
  run(Effect.gen(function* () {
    const host = yield* shardHost()
    const laptop = yield* open(host, ada, nodeOf(ADA, "laptop"))
    const phone = yield* open(host, bob, nodeOf(BOB, "phone"))
    const head = Effect.map(host.head(conversation), (position) => position.seq)
    const answer = { ...row("a1", ADA, ""), role: "assistant", questionId: "q1" } as const
    yield* (yield* laptop.messages.insert(answer)).persisted
    yield* (yield* laptop.messages.insert(row("q1", ADA, "Why?"))).persisted
    expect(yield* head).toBe(2)

    // The body alone: one command, the whole body so far, and no status asked for.
    yield* (yield* laptop.messages.update("a1", (draft) => void (draft.body = "Be"))).persisted
    expect(yield* host.events(conversation, 2)).toEqual([[{ _tag: "MessageBodyUpdated", id: "a1", body: "Be" }]])
    // What the answer said, how it ended and its end, in one write: body, then metadata, then status.
    host.requests.length = 0
    yield* (yield* laptop.messages.update("a1", (draft) => {
      draft.body = "Because."
      draft.stopReason = "end_turn"
      draft.status = "complete"
    })).persisted
    expect(submits(host)).toBe(3)
    expect(yield* host.events(conversation, 3)).toEqual([
      [{ _tag: "MessageBodyUpdated", id: "a1", body: "Because." }],
      [{ _tag: "MessageMetadataUpdated", id: "a1", stopReason: "end_turn" }],
      [{ _tag: "MessageStatusUpdated", id: "a1", status: "complete" }],
    ])
    expect(Option.getOrThrow(yield* laptop.messages.get("a1"))).toMatchObject({ body: "Because.", status: "complete", hubSeq: 1 })

    // Finished: the reducer refuses a longer body, and the note written with it is never sent.
    host.requests.length = 0
    const late = yield* laptop.messages.update("a1", (draft) => {
      draft.body = "Because. And more."
      draft.summary = "never written"
    })
    expect(yield* failureOf(late)).toEqual(new MessagesWriteRefused({ reason: "refused", detail: "terminal_body" }))
    expect(submits(host)).toBe(1)
    expect(Option.getOrThrow(yield* laptop.messages.get("a1"))).toMatchObject({ body: "Because." })
    // A question is never rewritten, by the person who asked it either: ChatApi's refusal, and no status after it.
    host.requests.length = 0
    const rewritten = yield* laptop.messages.update("q1", (draft) => {
      draft.body = "Why? Because."
      draft.status = "streaming"
    })
    expect(yield* failureOf(rewritten)).toEqual(
      new MessagesShardUnavailable({ request: "submit", reason: "refused", status: 403, refusal: "question" }),
    )
    expect(submits(host)).toBe(1)
    // A body that does not extend the one shown has no command at all.
    expect(yield* failureOf(yield* laptop.messages.update("a1", (draft) => void (draft.body = "No."))))
      .toEqual(new MessagesWriteRefused({ reason: "unsupported", detail: "update" }))
    expect(yield* head).toBe(6)
    expect((yield* laptop.state).outbox).toEqual([])

    // Another person's replica folds the same body, and both hash as the shard does.
    yield* phone.resume
    expect((yield* phone.chat).messages.map((message) => [message.id, message.body, message.status])).toEqual([
      ["a1", "Because.", "complete"],
      ["q1", "Why?", "posted"],
    ])
    expect(canonicalHash(yield* phone.chat)).toBe((yield* host.state(conversation)).hash)
    expect(canonicalHash(yield* laptop.chat)).toBe((yield* host.state(conversation)).hash)
  })))
