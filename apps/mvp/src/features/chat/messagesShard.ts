import { type Chat, Chat as ChatState, type ChatCommand, ChatEvent, emptyChat, evolveChat, Message } from "@smthrs/app-state"
import { type Collection, JournalCollection } from "@smthrs/effect-tanstack-db"
import { ShardClient, ShardProtocol } from "@smthrs/sync"
import { Context, Data, type Duration, Effect, Layer, Queue, Schedule, Schema, Scope, Semaphore, Stream, SubscriptionRef } from "effect"
import { HttpClient } from "effect/http"
import * as MessagesShardClient from "./messagesShardClient"
import { isTransient, MessagesShardUnavailable, nodeOf, shardOf } from "./messagesShardClient"

// One conversation's messages on this tab, read from its SQLite shard (decision 0170, slice 4). A `ShardClient` keeps
// the outbox and the cursor in its store; each page it pulls is folded with the shard's own reducer (`evolveChat`,
// `@smthrs/app-state`) into this tab's projection; and a `JournalCollection` shows the projection through TanStack DB.
// A write to the collection shows at once, is queued as a command under a `(node, commandId)` key and stays queued
// while the shard cannot be reached. Electric still serves the conversation the chat pages show (store.ts): this is
// the shard's read and write side, ready for the shape to leave.

/** A message as the shard's reducer holds it: `hubSeq` is the entry that posted it, `0` on an optimistic row. */
export const ShardMessage = Message
export type ShardMessage = typeof Message.Type

const Snapshot = Schema.Struct({ chat: ChatState })
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot)
const decodeEvent = Schema.decodeUnknownSync(ChatEvent)

/** Folds one delivery into a projection, as the shard folds it (worker/chat/MessagesShard.ts `apply`). */
export const fold = (chat: Chat, delivery: ShardClient.Delivery): Chat => {
  if (delivery._tag === "Reset") {
    return delivery.snapshot.state === null ? emptyChat : decodeSnapshot(delivery.snapshot.state).chat
  }
  return delivery.entries.reduce<Chat>(
    (state, entry) =>
      entry.events.reduce<Chat>((current, event) => evolveChat(current, entry.seq, decodeEvent(event)), state),
    chat,
  )
}

type Batch = JournalCollection.Batch<ShardMessage, string>
type Change = JournalCollection.RowChange<ShardMessage, string>

/** The rows one fold changed. The reducer only appends a message or replaces the one whose status moved. */
export const changesBetween = (before: Chat, after: Chat): ReadonlyArray<Change> => {
  const known = new Map(before.messages.map((message) => [message.id, message]))
  return after.messages.flatMap((message): ReadonlyArray<Change> => {
    const was = known.get(message.id)
    if (was === undefined) return [{ type: "insert", value: message }]
    return was === message ? [] : [{ type: "update", value: message }]
  })
}

/**
 * The shard decided against a write, so its optimistic row rolls back:
 * - `refused`: the reducer's `reason` (`message_conflict`, `message_missing`, `terminal_status`), kept as the key's
 *   receipt;
 * - `idempotency_conflict`: its key already names a command with other content, so this node's id is not its own;
 * - `unsupported`: the reducer has no command for it (a delete, or an update that changes more than the status).
 */
export class MessagesWriteRefused extends Data.TaggedError("MessagesWriteRefused")<{
  readonly reason: "refused" | "idempotency_conflict" | "unsupported"
  readonly detail?: string
}> {}

/**
 * Where the replica stands with its shard: `pending` before its first answer, `ok` once a sync reached the head,
 * `failing` while requests fail in a way a retry can fix, `refused` when ChatApi or the protocol decided against it.
 */
export interface MessagesShardStatus {
  readonly state: "pending" | "ok" | "failing" | "refused"
  /** The last `hubSeq` the projection has applied. */
  readonly through: number
}

export interface ReplicaOptions {
  readonly conversationId: string
  /**
   * The node this replica submits from: its owner's name, a slash and a device (`nodeOf`). Command ids count up in
   * `store`, so a node must be used with one store only: a second store under it reuses ids for other content, which
   * the shard answers `IdempotencyConflict`.
   */
  readonly node: string
  readonly transport: ShardClient.Transport<MessagesShardUnavailable>
  /** The outbox and cursor. Default: in memory, for a node that lives as long as the tab. */
  readonly store?: ShardClient.ClientStore
  /** How long a queued write waits before its sync is sent again. Default: every second, for as long as it takes. */
  readonly retry?: Schedule.Schedule<unknown>
  /** Syncs this often in the background, from the start. Absent: only `resume` and writes sync. */
  readonly follow?: Duration.Input
  /** Entries per pulled page. Default `ShardClient`'s, 256. */
  readonly limit?: number
}

const keyText = (key: readonly [string, string]) => JSON.stringify(key)

/** The command a collection write asks the shard to sequence. */
const commandOf = (
  mutation: JournalCollection.Mutation<ShardMessage, string>,
  known: ShardMessage | undefined,
): Effect.Effect<ChatCommand, MessagesWriteRefused> => {
  const { type, value } = mutation
  if (type === "insert") {
    return value.status === "posted"
      ? Effect.succeed({ _tag: "PostMessage", messageId: value.id, author: value.author, body: value.body })
      : Effect.fail(new MessagesWriteRefused({ reason: "unsupported", detail: "insert_status" }))
  }
  if (type === "update" && known !== undefined && known.author === value.author && known.body === value.body) {
    return Effect.succeed({ _tag: "UpdateMessageStatus", messageId: value.id, status: value.status })
  }
  return Effect.fail(new MessagesWriteRefused({ reason: "unsupported", detail: type }))
}

/**
 * A replica of one conversation's shard, closed with the scope: its messages as a TanStack DB collection, its status,
 * and `resume`, which submits what the outbox holds and pulls after the cursor. A reconnect is a `resume`.
 */
export const make = Effect.fnUntraced(function* (options: ReplicaOptions) {
  const shard = shardOf(options.conversationId)
  const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)
  const store = options.store ?? ShardClient.memoryStore()
  const retry = options.retry ?? Schedule.spaced("1 second")

  // The projection: what every applied delivery folds to, and the batch each one publishes.
  let chat = emptyChat
  let through = 0
  const subscribers = new Set<(batch: Batch) => void>()
  const snapshotBatch = (): Batch => ({
    snapshot: true,
    through,
    changes: chat.messages.map((value): Change => ({ type: "insert", value })),
  })
  const apply = (delivery: ShardClient.Delivery) =>
    Effect.try({
      try: () => {
        const next = fold(chat, delivery)
        const changes = changesBetween(chat, next)
        chat = next
        through = delivery._tag === "Reset" ? delivery.snapshot.position.seq : delivery.through.seq
        const batch = delivery._tag === "Reset" ? snapshotBatch() : { snapshot: false, through, changes }
        for (const subscriber of subscribers) subscriber(batch)
      },
      catch: () => new MessagesShardUnavailable({ request: "pull", reason: "invalid_response" }),
    })
  const batches = Stream.callback<Batch>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        Queue.offerUnsafe(queue, snapshotBatch())
        const subscriber = (batch: Batch) => void Queue.offerUnsafe(queue, batch)
        subscribers.add(subscriber)
        return subscriber
      }),
      (subscriber) => Effect.sync(() => subscribers.delete(subscriber)),
    )
  )

  const client = yield* ShardClient.make({
    shard,
    node: options.node,
    transport: options.transport,
    store,
    apply,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  })

  const status = yield* SubscriptionRef.make<MessagesShardStatus>({ state: "pending", through })
  const report = (state: MessagesShardStatus["state"]) =>
    Effect.suspend(() => SubscriptionRef.set(status, { state, through }))
  const stateOf = (error: MessagesShardUnavailable | ShardProtocol.ShardError) =>
    error._tag === "MessagesShardUnavailable" && isTransient(error) ? "failing" : "refused"
  const sync = client.sync.pipe(
    Effect.tap(() => report("ok")),
    Effect.tapError((error) => report(stateOf(error))),
    Effect.annotateLogs({ feature: "chat", conversationId: options.conversationId }),
  )

  /** Takes this write's refusals out of the store, so each is reported once and the store stays bounded. */
  const takeRefusal = (mine: ReadonlySet<string>) =>
    store.modify((state) => {
      const failures = state.terminalFailures ?? []
      const rest = failures.filter((failure) => !mine.has(keyText(failure.key)))
      const { terminalFailures: _, ...kept } = state
      return [
        failures.find((failure) => mine.has(keyText(failure.key))),
        rest.length === 0 ? kept : { ...kept, terminalFailures: rest },
      ] as const
    })
  /** Takes this write's commands out of the outbox: ChatApi decided against them, so they are never sent again. */
  const withdraw = (mine: ReadonlySet<string>) =>
    store.modify((state) => [
      undefined,
      { ...state, outbox: state.outbox.filter((command) => !mine.has(keyText(command.key))) },
    ])

  const submit: JournalCollection.Source<ShardMessage, string>["submit"] = (mutations) =>
    Effect.gen(function* () {
      const known = new Map(chat.messages.map((message) => [message.id, message]))
      // Every write is translated before any is queued, so a transaction is queued whole or not at all.
      const payloads = yield* Effect.forEach(mutations, (mutation) => commandOf(mutation, known.get(mutation.key)))
      const commands = yield* Effect.forEach(payloads, (payload) => client.enqueue(stream, payload))
      const mine = new Set(commands.map((command) => keyText(command.key)))
      // Queued until the shard answers: a failure a retry can fix is retried, so the row stays shown while offline.
      const position = yield* sync.pipe(
        Effect.retry({
          schedule: retry,
          while: (error) => error._tag === "MessagesShardUnavailable" && isTransient(error),
        }),
        Effect.tapError(() => withdraw(mine)),
      )
      const refusal = yield* takeRefusal(mine)
      if (refusal !== undefined) {
        return yield* refusal._tag === "Refused"
          ? new MessagesWriteRefused({ reason: "refused", detail: refusal.reason })
          : new MessagesWriteRefused({ reason: "idempotency_conflict" })
      }
      return position.seq
    })

  const messages: Collection.Collection<ShardMessage, string> = yield* JournalCollection.make({
    id: `chat-shard-messages:${options.conversationId.toLowerCase()}`,
    schema: ShardMessage,
    getKey: (row) => row.id,
    source: { batches, submit },
  })
  // Ready before anyone writes: a write settles against the batches this subscription applies.
  yield* Effect.orDie(messages.preload)

  if (options.follow !== undefined) {
    yield* Effect.ignore(sync).pipe(Effect.repeat(Schedule.spaced(options.follow)), Effect.forkScoped)
  }

  return {
    conversationId: options.conversationId,
    shard,
    messages,
    status,
    /** Submits the outbox and pulls after the cursor: what a reconnect, a restart and Retry all do. */
    resume: sync,
    /** The outbox, the cursor and the epoch, as the store holds them now. */
    state: client.state,
    /** The projection now: what the shard's own reducer folds the applied entries to. */
    chat: Effect.sync(() => chat),
  }
})

export type MessagesShardReplica = Effect.Success<ReturnType<typeof make>>

/** Where this tab reaches the shards, and the node it submits from. */
export interface MessagesShardsConfig extends Omit<MessagesShardClient.TransportOptions, "conversationId">,
  Pick<ReplicaOptions, "retry" | "follow" | "limit">
{
  /** The signed-in person's owner name (`personOwner`): the author of what this tab posts. */
  readonly owner: string
  /**
   * This device, unique to the stores `storeFor` gives: with the default in-memory stores, a fresh id per page load.
   */
  readonly device: string
  /** A conversation's outbox and cursor. Default: in memory. */
  readonly storeFor?: (conversationId: string) => ShardClient.ClientStore
}

/** This tab's shard replicas: one per conversation, opened on first use and kept for as long as the layer lives. */
export class MessagesShards extends Context.Service<
  MessagesShards,
  {
    readonly open: (conversationId: string) => Effect.Effect<MessagesShardReplica>
    /** A replica opened before, if any: what a frontend reads without waiting. */
    readonly opened: (conversationId: string) => MessagesShardReplica | undefined
  }
>()("@smthrs/mvp/chat/MessagesShards") {
  static readonly layer = (config: MessagesShardsConfig) =>
    Layer.effect(
      MessagesShards,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const http = yield* HttpClient.HttpClient
        const replicas = new Map<string, MessagesShardReplica>()
        // One at a time, so two callers opening one conversation open it once.
        const opening = yield* Semaphore.make(1)
        const open = (id: string) =>
          Effect.gen(function* () {
            const known = replicas.get(id)
            if (known !== undefined) return known
            const transport = yield* MessagesShardClient.make({
              origin: config.origin,
              conversationId: id,
              within: config.within,
            })
            const { storeFor, retry, follow, limit } = config
            const replica = yield* make({
              conversationId: id,
              node: nodeOf(config.owner, config.device),
              transport,
              ...(storeFor === undefined ? {} : { store: storeFor(id) }),
              ...(retry === undefined ? {} : { retry }),
              ...(follow === undefined ? {} : { follow }),
              ...(limit === undefined ? {} : { limit }),
            })
            replicas.set(id, replica)
            return replica
          }).pipe(Scope.provide(scope), Effect.provideService(HttpClient.HttpClient, http))
        return MessagesShards.of({
          open: (conversationId) => Semaphore.withPermits(opening, 1)(open(conversationId.toLowerCase())),
          opened: (conversationId) => replicas.get(conversationId.toLowerCase()),
        })
      }),
    )
}
