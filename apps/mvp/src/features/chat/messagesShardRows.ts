import { canonicalJson } from "@smthrs/app-state"
import { Collection, JournalCollection } from "@smthrs/effect-tanstack-db"
import { Data, type Duration, Effect, Option, Schedule, type Scope, Stream, SubscriptionRef } from "effect"
import type { HttpClient } from "effect/http"
import * as MessagesShard from "./messagesShard"
import { type MessagesShardReplica, type MessagesShardStatus, type Projection, rowsOf } from "./messagesShard"
import * as MessagesShardClient from "./messagesShardClient"
import { type Message, ShardRow } from "./schema"

// One conversation's messages as the chat store reads them, from the conversation's messages shard instead of
// Electric's `messages` shape (decision 0170, slice 5a). A replica follows the shard (messagesShard.ts); this shows its
// projection as the rows Electric delivers (schema.ts `Message`), ordered by where Postgres put each message, with the
// sync signal the connection pill reads. Nothing here writes: a question still goes through ChatApi, which stores it in
// Postgres and bridges it into the shard (worker/chat/MessagesShardBridge.ts), and this reads it back.

/**
 * What a sync told the store, in the vocabulary of a shape's requests (`@smthrs/effect-electric` `SyncEvent`, which
 * every event of a shape also satisfies): a request went out (`Sent`), was answered (`Succeeded`), failed in a way a
 * retry can fix (`Failed`), or was decided against, which waits for Retry (`Stopped`; no `status` when the answer
 * could not be read).
 */
export type SyncEvent =
  | { readonly _tag: "Sent" }
  | { readonly _tag: "Succeeded" }
  | { readonly _tag: "Failed"; readonly status?: number }
  | { readonly _tag: "Stopped"; readonly error: { readonly status?: number } }

/**
 * A conversation's messages as the chat store reads them, whichever way they sync: the rows, read-only, each sync's
 * outcome, a tick per batch applied, and `reconnect`, which syncs now and restarts a sync that stopped. `whole`, where
 * there is one, completes once the rows hold everything the server had when they first synced: a store waits for it
 * rather than for the first rows, which may be one page of several.
 */
export interface SyncedMessages extends Collection.Collection<Message> {
  readonly sync: Stream.Stream<SyncEvent>
  readonly applied: Stream.Stream<void>
  readonly reconnect: Effect.Effect<void>
  readonly whole?: Effect.Effect<void, unknown>
}

/** A write to the rows: they are read-only. A question is asked through ChatApi, never written here. */
export class MessagesReadOnly extends Data.TaggedError("MessagesReadOnly")<{}> {}

type Batch = JournalCollection.Batch<ShardRow, Collection.Key>

/**
 * The batch that takes a collection showing `shown` to `rows`, with cursor `through`. The first is a snapshot. So is
 * one after a row left: the shard only appends, so a row is gone only when the replica rebuilt from a snapshot of
 * another history, or hid a conversation ChatApi refused. Any other is the rows that are new or changed, which is
 * none when a delivery changed nothing a row shows.
 */
export const batchOf = (
  shown: ReadonlyMap<string, ShardRow> | undefined,
  rows: ReadonlyArray<ShardRow>,
  through: number,
): Batch => {
  const ids = new Set(rows.map((row) => row.id))
  if (shown === undefined || [...shown.keys()].some((id) => !ids.has(id))) {
    return { snapshot: true, through, changes: rows.map((value) => ({ type: "insert", value })) }
  }
  return {
    snapshot: false,
    through,
    changes: rows.flatMap((value): Batch["changes"] => {
      const was = shown.get(value.id)
      if (was === undefined) return [{ type: "insert", value }]
      return canonicalJson(was) === canonicalJson(value) ? [] : [{ type: "update", value }]
    }),
  }
}

/** What a replica's status says of its last sync. Before its first answer it says nothing. */
export const eventsOf = (status: MessagesShardStatus): ReadonlyArray<SyncEvent> => {
  const answered = status.status === undefined ? {} : { status: status.status }
  if (status.state === "ok") return [{ _tag: "Succeeded" }]
  if (status.state === "failing") return [{ _tag: "Failed", ...answered }]
  return status.state === "refused" ? [{ _tag: "Stopped", error: answered }] : []
}

export interface RowsOptions<F = number> {
  /** How often the replica syncs with its shard. */
  readonly follow: Duration.Input
  /** Whoever keeps the conversation's refusals (src/features/conversations/owners.ts). */
  readonly refusals?: Refusals<F>
}

/**
 * What a conversation's rows tell whoever keeps its refusals, here and in the device's other tabs:
 * - `refuse` in the turn ChatApi refuses a read, before the rows are taken away, so whatever else shows of the
 *   conversation is hidden no later than they are;
 * - `clear` once the rows of a sync ChatApi answered whole are committed, with the `fence` that sync began at, so
 *   nothing returns before they do, and a refusal recorded after the sync began, in this tab or another, stands.
 *
 * Every such sync is told, the first included: until ChatApi has answered whole a read that began after a refusal,
 * nothing says the person may read the conversation, and a refusal the device kept from an earlier load stands.
 * `F` is whatever the keeper takes as a sync begins: the rows hand it back as it was.
 */
export interface Refusals<F = number> {
  readonly fence: () => F
  readonly refuse: () => void
  readonly clear: (fence: F) => Effect.Effect<unknown>
}

/**
 * `replica`'s messages as rows, followed until the scope closes. The replica syncs at once and then every `follow`.
 * A sync ChatApi decided against stops the following, as a stopped shape stops, until `reconnect`. `restored` is
 * immediate, since nothing is kept on the device; `preload` and `whole` wait for the first sync that reached the
 * shard's head and for the collection to commit what it folded, so a conversation is shown neither empty nor in part
 * before its messages arrive. A collection that stopped before it committed them (`JournalStopped`: its apply failed,
 * its source ended, its scope closed) fails both, and ticks no `applied`: nothing is ready, and nothing recovered,
 * that the collection does not hold.
 *
 * Readiness is the collection's own word (`JournalCollection` `reached`), never a comparison of rows: each batch
 * carries the projection's `version` as its cursor, a status names the version the projection had published when its
 * sync ended, and the rows hold that sync once the collection has committed a batch at or past it.
 */
export const make = Effect.fnUntraced(function* <F = number>(replica: MessagesShardReplica, options: RowsOptions<F>) {
  const context = { conversationId: replica.conversationId }
  // What the collection shows is each subscription's own: one that starts again starts from a snapshot.
  const batches = Stream.suspend(() => {
    let shown: ReadonlyMap<string, ShardRow> | undefined
    return replica.projections.pipe(Stream.map(({ chat, version }: Projection) => {
      const rows = rowsOf(chat, context)
      const batch = batchOf(shown, rows, version)
      shown = new Map(rows.map((row) => [row.id, row]))
      return batch
    }))
  })
  const rows = yield* JournalCollection.make<ShardRow, Collection.Key>({
    id: `chat-shard-rows:${replica.conversationId.toLowerCase()}`,
    schema: ShardRow,
    getKey: (row) => row.id,
    source: { batches, submit: () => Effect.fail(new MessagesReadOnly()) },
  })
  const statuses = SubscriptionRef.changes(replica.status)
  const resume = Effect.ignore(replica.resume)
  yield* Effect.flatMap(SubscriptionRef.get(replica.status), (status) => (status.state === "refused" ? Effect.void : resume)).pipe(
    Effect.repeat(Schedule.spaced(options.follow)),
    Effect.forkScoped,
  )
  // A sync has reached the head once its status says so; its last batch reaches the collection a turn later. The
  // collection has committed it once its cursor is at or past the version the status names. A collection whose run
  // stopped before that never committed it, and says so (`JournalStopped`): no caller reads that as committed.
  const committed = (status: MessagesShardStatus) => rows.reached(status.version)
  const whole = rows.preload.pipe(
    Effect.andThen(statuses.pipe(Stream.filter((status) => status.state === "ok"), Stream.take(1), Stream.runHead)),
    Effect.flatMap((status) => committed(Option.getOrThrow(status))),
  )
  const told = options.refusals
  if (told !== undefined) {
    yield* replica.onRefused(told.refuse)
    // Allowed again only once the rows ChatApi answered whole are committed, and only past the refusals the sync
    // began after (`status.fence`, which the replica reports as `told.fence` answered it): one recorded since, by this replica or another tab, is never undone by an answer
    // that may be older than it, and waits for the next sync. A commit that failed clears nothing.
    yield* statuses.pipe(
      Stream.filter((status) => status.state === "ok"),
      Stream.runForEach((status) =>
        committed(status).pipe(
          Effect.andThen(Effect.suspend(() => told.clear(status.fence as F))),
          Effect.ignore,
        )),
      Effect.forkScoped,
    )
  }
  const synced: SyncedMessages = {
    ...(rows as unknown as Collection.Collection<Message>),
    preload: Effect.mapError(whole, (cause) => (cause._tag === "LoadFailed" ? cause : new Collection.LoadFailed({ cause }))),
    whole,
    restored: Effect.void,
    sync: statuses.pipe(Stream.map(eventsOf), Stream.flattenIterable),
    // A tick once the collection has committed what a sync that reached the head left: when the projection moved, and
    // when it did not but the sync before it failed, so a retry that finds nothing new is still a recovery. A sync
    // that neither moved the projection nor followed a failure says nothing, and neither does the status as it stood
    // when the stream started. Only a commit counts: a version the collection stopped before committing ticks
    // nothing and is not remembered, so the next sync that is committed is the recovery.
    applied: Stream.suspend(() => {
      let first = true
      let seen: number | undefined
      return statuses.pipe(
        Stream.mapEffect((status) => {
          const starts = first
          first = false
          if (status.state !== "ok") {
            seen = undefined
            return Effect.succeed(false)
          }
          if (seen === status.version) return Effect.succeed(false)
          return Effect.match(committed(status), {
            onFailure: () => false,
            onSuccess: () => {
              seen = status.version
              return !starts
            },
          })
        }),
        Stream.filter((ticks) => ticks),
        Stream.map(() => undefined),
      )
    }),
    reconnect: resume,
  }
  return synced
})

export interface OpenOptions<F = number> extends MessagesShardClient.TransportOptions, RowsOptions<F> {
  /** Entries per pulled page. Default `ShardClient`'s, 256. */
  readonly limit?: number
}

/** The node a reading replica names. It never submits, so the shard never sees it. */
const READER = MessagesShardClient.nodeOf("reader", "rows")

/**
 * Conversation `conversationId`'s messages, read from its shard on ChatApi's `origin` over the page's own signed-in
 * requests. Each call opens a replica of its own, in memory: a tab that closes takes nothing with it, and one that
 * opens rebuilds from the shard's snapshot and the entries after it.
 */
export const open = <F = number>(options: OpenOptions<F>): Effect.Effect<SyncedMessages, never, HttpClient.HttpClient | Scope.Scope> =>
  Effect.gen(function* () {
    const denials = options.denials === undefined ? {} : { denials: options.denials }
    const transport = yield* MessagesShardClient.make({
      origin: options.origin,
      conversationId: options.conversationId,
      within: options.within,
      ...denials,
    })
    const refusals = options.refusals === undefined ? {} : { refusals: options.refusals }
    const replica = yield* MessagesShard.make({
      conversationId: options.conversationId,
      node: READER,
      transport,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...denials,
      ...(options.refusals === undefined ? {} : { fence: options.refusals.fence }),
    })
    return yield* make(replica, { follow: options.follow, ...refusals })
  })
