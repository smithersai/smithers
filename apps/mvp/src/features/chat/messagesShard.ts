import {
  answerOwner,
  canonicalJson,
  type Chat,
  Chat as ChatState,
  type ChatCommand,
  ChatEvent,
  emptyChat,
  evolveChat,
  isBridged,
  Message,
  type MessageMetadata,
  metadataOf,
  originOf,
  placesOf,
  questionOwner,
} from "@smthrs/app-state"
import { type Collection, JournalCollection } from "@smthrs/effect-tanstack-db"
import { ShardClient, ShardProtocol } from "@smthrs/sync"
import { Context, Data, type Duration, Effect, Layer, Queue, Schedule, Schema, Scope, Semaphore, Stream, SubscriptionRef } from "effect"
import { HttpClient } from "effect/http"
import * as MessagesShardClient from "./messagesShardClient"
import { isTransient, MessagesShardUnavailable, nodeOf, PERSON_OWNER_PREFIX, shardOf } from "./messagesShardClient"
import type { ShardRow as ChatRow } from "./schema"

// One conversation's messages on this tab, read from its SQLite shard (decision 0170, slice 4). A `ShardClient` keeps
// the outbox and the cursor in its store; each page it pulls is folded with the shard's own reducer (`evolveChat`,
// `@smthrs/app-state`) into this tab's projection; and a `JournalCollection` shows the projection through TanStack DB.
// A write to the collection shows at once, is queued as a command under a `(node, commandId)` key and stays queued
// while the shard cannot be reached. A chat page reads a branch conversation through it where the store is configured
// to (messagesShardRows.ts, store.ts `ChatConfig.shard`); Electric serves it everywhere else.

/**
 * A message as the shard's reducer holds it: `hubSeq` is the entry that posted it, `0` on an optimistic row. Besides
 * its id, author, body and status it may carry what its post said (`role`, `questionId`, `position`, `createdAt`),
 * what its run wrote (`parts`, `failure`, `modelId`, `stopReason`, token counts) and what was noted on it since
 * (`summary`, `summaryRevision`, `phase`, `arc`, `updatedAt`); a message from before the reducer carried them has none.
 */
export const ShardMessage = Message
export type ShardMessage = typeof Message.Type

/** What a chat row says that its shard message does not: the conversation is the shard's, not the message's. */
export interface RowContext {
  readonly conversationId: string
}

const ROW_STATUS = { posted: "done", streaming: "streaming", complete: "done", failed: "failed" } as const

/**
 * A shard message as the row chat's queries and pages read (schema.ts `Message`): the projection that replaces
 * Electric's `messages` row. What the message lacks takes the value Postgres gives the column, or one read off the
 * message itself:
 * - `role`: read off the author the shard verified, never off the post alone. Only a person's message can be a
 *   question (`user`), and is one unless its post says otherwise; anyone else's is an answer (`assistant`), whatever
 *   its post says;
 * - `position`: `place`, where the message reads among the projection's (`@smthrs/app-state` `placesOf`, the rule
 *   Lean's `Chat.places` proves, which `rowsOf` applies): Postgres's place for a message ChatApi's bridge posted, and
 *   for anyone else's where the shard sequenced it, after every message that was there. A position another writer's
 *   post names is not read. Rows order by it, never by the order posts arrived in;
 * - `createdAt`, `updatedAt`: Postgres's times, which only the bridge says (`isBridged`): empty on anyone else's
 *   message, whatever its post or a patch names, and `updatedAt` is the time it was made until one is written;
 * - `phase`, `arc`: none when the mark was taken away (`""`), as when there never was one;
 * - `questionId`: `asked`, the question the message answers when the pair is ChatApi's own (`rowsOf`), and none
 *   otherwise: a question id any other post names is never read, so no writer makes its message an exchange's answer
 *   on the timeline (src/features/timeline/marks.ts);
 * - `shardSeq`: the entry that posted it, which orders two rows that read at one place as the shard holds them;
 * - every other column: `null`, and no `parts` at all, as on a row the device kept from before the app read them.
 *
 * A posted message is `done`: the row has no status for a question that is only stored.
 */
export const rowOf = (message: ShardMessage, context: RowContext, place: number, asked: string | null = null): ChatRow => {
  const bridged = isBridged(message)
  const createdAt = (bridged ? message.createdAt : undefined) ?? ""
  return {
    id: message.id,
    role: message.author.startsWith(PERSON_OWNER_PREFIX) ? message.role ?? "user" : "assistant",
    text: message.body,
    status: ROW_STATUS[message.status],
    questionId: asked,
    failure: message.failure ?? null,
    modelId: message.modelId ?? null,
    stopReason: message.stopReason ?? null,
    inputTokens: message.inputTokens ?? null,
    outputTokens: message.outputTokens ?? null,
    position: place,
    createdAt,
    updatedAt: (bridged ? message.updatedAt : undefined) ?? createdAt,
    conversationId: context.conversationId,
    ...(message.parts === undefined ? {} : { parts: message.parts }),
    summary: message.summary ?? null,
    summaryRevision: message.summaryRevision ?? null,
    phase: message.phase || null,
    arc: message.arc || null,
    shardSeq: message.hubSeq,
  }
}

/**
 * A projection as rows, in the order the shard holds its messages, each at its place (`placesOf`). One row can move:
 * an answer an earlier bridge posted with no position reads straight after its question once the bridge posts that
 * question with one. No other row's place changes once it is shown.
 */
export const rowsOf = (chat: Chat, context: RowContext): ReadonlyArray<ChatRow> => {
  const places = placesOf(chat.messages)
  // The questions ChatApi's bridge posted. An answer is paired with one only when the bridge posted the answer too:
  // both names are the bridge's alone (worker/chat/MessagesShard.ts `bridges`), so the pair is Postgres's.
  const questions = new Set(chat.messages.filter((message) => message.author === questionOwner(message.id)).map((message) => message.id))
  return chat.messages.map((message, index) =>
    rowOf(
      message,
      context,
      places[index]!,
      message.author === answerOwner(message.id) && message.questionId !== undefined && questions.has(message.questionId)
        ? message.questionId
        : null,
    ))
}

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

/**
 * A replica's projection as a reader may show it: the shard's messages, none while ChatApi refuses the conversation;
 * the last `hubSeq` applied to them; and `version`, which counts each time what may be shown changed, a delivery
 * folded or the conversation hidden or shown again. It only rises, where `through` stands still across a refusal.
 */
export interface Projection {
  readonly chat: Chat
  readonly through: number
  readonly version: number
}

type Batch = JournalCollection.Batch<ShardMessage, string>
type Change = JournalCollection.RowChange<ShardMessage, string>

/** The rows one fold changed. The reducer only appends a message or replaces the one whose status, metadata or body moved. */
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
 * - `refused`: the reducer's `reason` (`message_conflict`, `message_missing`, `terminal_status`,
 *   `terminal_metadata`, `body_question`, `body_author`, `terminal_body`, `body_conflict`), kept as the key's receipt;
 * - `idempotency_conflict`: its key already names a command with other content, so this node's id is not its own;
 * - `unsupported`: the reducer has no command for it (a delete, an insert that is not `posted`, or an update that
 *   changes the author or what the post said, or whose body does not extend the one it had).
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
  /** The projection's `version` when this was reported: what it had published by then. */
  readonly version: number
  /** What `ReplicaOptions.fence` answered as the sync this reports began; `0` before the first, or with none. */
  readonly fence: unknown
  /** The HTTP status ChatApi answered a failing or refused request with, when it answered one. */
  readonly status?: number
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
  /**
   * The read `401`s the page sees arrive (`MessagesShardClient.ReadDenials`). With it, the conversation is hidden in
   * the task ChatApi's `401` to a read of it arrives in, before the page's transport checks the session: a check that
   * never answers leaves the read `unreachable` at its deadline, and the conversation still hidden.
   */
  readonly denials?: MessagesShardClient.ReadDenials
  /**
   * Read as each sync begins, and reported with what became of it (`MessagesShardStatus.fence`): where whoever keeps
   * refusals stood then, so an answer removes only the refusals it began after (owners.ts `clear`).
   */
  readonly fence?: () => unknown
}

/**
 * Whether ChatApi answered a read of the conversation by saying this person may not read it: signed out (`401`), not
 * allowed (`403`) or no such conversation for them (`404`). Each is ChatApi's own word on the read, so each hides the
 * conversation, a `401` the page's transport will retry as the same person's session included: what ChatApi would not
 * serve is not shown until it serves it. A refused write says nothing of reading, and neither does an answer that is
 * not ChatApi's decision on who may read (`5xx`, `400`, no answer at all).
 */
export const lostAccess = (error: MessagesShardUnavailable | ShardProtocol.ShardError): error is MessagesShardUnavailable =>
  error._tag === "MessagesShardUnavailable" && error.request !== "submit" && error.reason === "refused" &&
  [401, 403, 404].includes(error.status!)

const keyText = (key: readonly [string, string]) => JSON.stringify(key)

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right)

/**
 * The metadata `value` holds that `known` does not: what an update asks the shard to patch. A patch replaces fields
 * and never removes one, and neither does a collection update: its schema refuses a row whose field was taken away.
 */
const patchOf = (known: ShardMessage, value: ShardMessage): MessageMetadata => {
  const before: { readonly [key: string]: unknown } = metadataOf(known)
  return Object.fromEntries(
    Object.entries(metadataOf(value)).filter(([key, item]) => !Object.hasOwn(before, key) || !same(before[key], item)),
  )
}

const unsupported = (detail: string) => Effect.fail(new MessagesWriteRefused({ reason: "unsupported", detail }))

/**
 * The commands a collection write asks the shard to sequence, in order. An insert is one command: the post carries the
 * message with whatever the row says of it, so the shard takes all of it or none. An update extends the body when it
 * grew (a streamed answer writes the whole body it has so far, which the shard takes only from the message's own
 * author), patches the metadata that changed and then moves the status, so one write can record what an answer said,
 * how it ended and end it: the shard freezes a message's body and run metadata once its status is terminal. Each
 * command is sent only once the shard accepted the one before it (`submit`). An update that changes nothing still asks
 * for its status, which the shard answers without a new entry.
 */
const commandsOf = (
  mutation: JournalCollection.Mutation<ShardMessage, string>,
  known: ShardMessage | undefined,
): Effect.Effect<ReadonlyArray<ChatCommand>, MessagesWriteRefused> => {
  const { type, value } = mutation
  const patched = (patch: MessageMetadata): ReadonlyArray<ChatCommand> =>
    Object.keys(patch).length === 0 ? [] : [{ _tag: "UpdateMessageMetadata", messageId: value.id, ...patch }]
  if (type === "insert") {
    if (value.status !== "posted") return unsupported("insert_status")
    return Effect.succeed([{
      _tag: "PostMessage",
      messageId: value.id,
      author: value.author,
      body: value.body,
      ...originOf(value),
      ...metadataOf(value),
    }])
  }
  if (
    type === "update" && known !== undefined && known.author === value.author &&
    value.body.startsWith(known.body) && same(originOf(known), originOf(value))
  ) {
    const written: ReadonlyArray<ChatCommand> = [
      ...(known.body === value.body
        ? []
        : [{ _tag: "UpdateMessageBody" as const, messageId: value.id, author: value.author, body: value.body }]),
      ...patched(patchOf(known, value)),
    ]
    return Effect.succeed(
      written.length > 0 && known.status === value.status
        ? written
        : [...written, { _tag: "UpdateMessageStatus", messageId: value.id, status: value.status }],
    )
  }
  return unsupported(type)
}

/**
 * A replica of one conversation's shard, closed with the scope: its messages as a TanStack DB collection, its status,
 * and `resume`, which submits what the outbox holds and pulls after the cursor. A reconnect is a `resume`.
 *
 * A read ChatApi refuses because the person may no longer read the conversation (`lostAccess`) hides it at once: the
 * collection is emptied and every reader of the projection is given none of its messages, though the repository's
 * other rows still show. Whoever shows more of the conversation than its messages is told in the same turn, before the
 * rows go (`onRefused`). A read's `401` hides it as it arrives, where the page tells them (`ReplicaOptions.denials`),
 * whatever then becomes of the request. It is shown again only by a later sync ChatApi answered whole, which is ChatApi saying the
 * person may read it again, with everything sequenced meanwhile.
 */
export const make = Effect.fnUntraced(function* (options: ReplicaOptions) {
  const shard = shardOf(options.conversationId)
  const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)
  const store = options.store ?? ShardClient.memoryStore()
  const retry = options.retry ?? Schedule.spaced("1 second")

  // The projection: what every applied delivery folds to, and the batch each one publishes. `hidden` while ChatApi
  // refuses the conversation: what is folded is kept from every reader until a sync says it may be read again.
  let chat = emptyChat
  let through = 0
  let version = 0
  let hidden = false
  const subscribers = new Set<(batch: Batch) => void>()
  const watchers = new Set<() => void>()
  const refusals = new Set<() => void>()
  const dispatched = new Map<symbol, { readonly listeners: ReadonlyArray<() => void>; denied: boolean }>()
  let inScope = true
  const shown = (): Chat => (hidden ? emptyChat : chat)
  const snapshotBatch = (): Batch => ({
    snapshot: true,
    through,
    changes: shown().messages.map((value): Change => ({ type: "insert", value })),
  })
  const publish = (batch: Batch) => {
    version++
    for (const subscriber of subscribers) subscriber(batch)
    for (const watcher of watchers) watcher()
  }
  /** Hides the conversation, or shows it again: every reader is given the rows that may show now, as a snapshot. */
  const show = (visible: boolean) => {
    // Told first, in this turn: what else shows of the conversation is hidden before its rows are taken away. Every
    // refusal is told, one that finds the conversation hidden already included: a read another reader began after the
    // first refusal may be answered after this one, and its answer must not undo it (owners.ts `refuse`).
    if (!visible) for (const refusal of new Set([...refusals, ...[...dispatched.values()].flatMap((read) => read.listeners)])) refusal()
    if (hidden === !visible) return
    hidden = !visible
    publish(snapshotBatch())
  }
  const reveal = (visible: boolean) => Effect.sync(() => show(visible))
  // ChatApi's `401` to a read hides the conversation as it arrives. The sync it answers reports it afterwards, as
  // refused or, when the page's transport never returns it, as whatever became of the request: hidden either way, until
  // a sync ChatApi answers whole.
  const { denials } = options
  // Keep the idle replica informed too. Closing its owner releases this observer only after dispatched reads settle.
  const stopWatch = yield* Effect.acquireRelease(
    Effect.sync(() => denials?.watch(options.conversationId, () => {
      for (const read of dispatched.values()) read.denied = true
      show(false)
    }) ?? (() => {})),
    (stop) => Effect.sync(() => {
      inScope = false
      if (dispatched.size === 0) stop()
    }),
  )
  const apply = (delivery: ShardClient.Delivery) =>
    Effect.try({
      try: () => {
        const next = fold(chat, delivery)
        const changes = changesBetween(chat, next)
        chat = next
        through = delivery._tag === "Reset" ? delivery.snapshot.position.seq : delivery.through.seq
        // Folded while hidden, and shown by the sync that folds it only once ChatApi has answered it whole.
        if (!hidden) publish(delivery._tag === "Reset" ? snapshotBatch() : { snapshot: false, through, changes })
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

  /** The projection now, then again after each delivery it folds: what a reader of whole rows follows. */
  const projections = Stream.callback<Projection>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watcher = () => void Queue.offerUnsafe(queue, { chat: shown(), through, version })
        watcher()
        watchers.add(watcher)
        return watcher
      }),
      (watcher) => Effect.sync(() => watchers.delete(watcher)),
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

  const status = yield* SubscriptionRef.make<MessagesShardStatus>({ state: "pending", through, version, fence: 0 })
  const fenceNow = options.fence ?? (() => 0)
  const report = (state: MessagesShardStatus["state"], fence: unknown, answered?: number) =>
    Effect.suspend(() =>
      SubscriptionRef.set(status, { state, through, version, fence, ...(answered === undefined ? {} : { status: answered }) }))
  const stateOf = (error: MessagesShardUnavailable | ShardProtocol.ShardError) =>
    error._tag === "MessagesShardUnavailable" && isTransient(error) ? "failing" : "refused"
  const sync = Effect.suspend(() => {
    // Taken before the first request: a refusal recorded from here on is not one this sync's answer is later than.
    const fence = fenceNow()
    const dispatch = Symbol()
    const read = { listeners: [...refusals], denied: false }
    dispatched.set(dispatch, read)
    return client.sync.pipe(
      // Answered whole: the person may read the conversation, so what was hidden shows again, before the status says so.
      Effect.tap(() => Effect.andThen(reveal(true), report("ok", fence))),
      Effect.tapError((error) =>
        Effect.andThen(
          // Each refused read is told once: a `401` was told as it arrived, where the page tells them. Any other
          // refusal is told here, whatever else was heard meanwhile.
          lostAccess(error) && !(read.denied && error.status === 401) ? reveal(false) : Effect.void,
          report(stateOf(error), fence, error._tag === "MessagesShardUnavailable" ? error.status : undefined),
        )),
    ).pipe(Effect.ensuring(Effect.sync(() => {
      dispatched.delete(dispatch)
      if (!inScope && dispatched.size === 0) stopWatch()
    })))
  }).pipe(Effect.annotateLogs({ feature: "chat", conversationId: options.conversationId }))

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

  /**
   * Queues `payloads` and syncs until the shard has answered each: the `hubSeq` the projection reached, or the
   * refusal of the first one the shard decided against.
   */
  const send = (payloads: ReadonlyArray<ChatCommand>) =>
    Effect.gen(function* () {
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

  const submit: JournalCollection.Source<ShardMessage, string>["submit"] = (mutations) =>
    Effect.gen(function* () {
      const known = new Map(chat.messages.map((message) => [message.id, message]))
      // Every write is translated before any is queued, so a write the reducer has no command for queues nothing.
      const plans = yield* Effect.forEach(mutations, (mutation) => commandsOf(mutation, known.get(mutation.key)))
      // A write's later command depends on its earlier ones: it is queued only once the shard accepted them, so a
      // refused command is never followed by one that assumed it, in this tab or from the outbox after a restart.
      let seq = yield* send(plans.flatMap((plan) => plan.slice(0, 1)))
      for (let step = 1; plans.some((plan) => plan.length > step); step++) {
        seq = yield* send(plans.flatMap((plan) => plan.slice(step, step + 1)))
      }
      return seq
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
    /** The projection now, then after each delivery applied to it. */
    projections,
    status,
    /** Submits the outbox and pulls after the cursor: what a reconnect, a restart and Retry all do. */
    resume: sync,
    /** The outbox, the cursor and the epoch, as the store holds them now. */
    state: client.state,
    /** The projection now, as a reader may show it: what the shard's own reducer folds the applied entries to. */
    chat: Effect.sync(shown),
    /** Whether ChatApi refuses the person the conversation now: hidden, until a sync it answers whole. */
    refused: () => hidden,
    /**
     * Calls `listener` each time ChatApi refuses the person the conversation, in the turn that hides it and before its
     * rows are taken from any reader, until the scope closes.
     */
    onRefused: (listener: () => void) =>
      Effect.acquireRelease(Effect.sync(() => void refusals.add(listener)), () => Effect.sync(() => void refusals.delete(listener))),
  }
})

export type MessagesShardReplica = Effect.Success<ReturnType<typeof make>>

/** Where this tab reaches the shards, and the node it submits from. */
export interface MessagesShardsConfig extends Omit<MessagesShardClient.TransportOptions, "conversationId">,
  Pick<ReplicaOptions, "retry" | "follow" | "limit">
{
  /**
   * The signed-in person's owner name in a conversation: the author of what this tab posts there. Each conversation
   * has its own. Default: ChatApi is asked for it (`MessagesShardClient.writer`), once per conversation.
   */
  readonly ownerIn?: (conversationId: string) => Effect.Effect<string, MessagesShardUnavailable>
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
    /**
     * The conversation's replica, opened on first use under the person's owner name in that conversation. It fails
     * when that name cannot be learned, and the next call asks again.
     */
    readonly open: (conversationId: string) => Effect.Effect<MessagesShardReplica, MessagesShardUnavailable>
    /** A replica opened before, if any: what a frontend reads without waiting. */
    readonly opened: (conversationId: string) => MessagesShardReplica | undefined
    /** The owner name an opened conversation's replica writes under: the `author` of a row this tab inserts there. */
    readonly ownerOf: (conversationId: string) => string | undefined
  }
>()("@smthrs/mvp/chat/MessagesShards") {
  static readonly layer = (config: MessagesShardsConfig) =>
    Layer.effect(
      MessagesShards,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const http = yield* HttpClient.HttpClient
        const replicas = new Map<string, MessagesShardReplica>()
        const owners = new Map<string, string>()
        // One at a time, so two callers opening one conversation open it once.
        const opening = yield* Semaphore.make(1)
        const open = (id: string) =>
          Effect.gen(function* () {
            const known = replicas.get(id)
            if (known !== undefined) return known
            const target = {
              origin: config.origin, conversationId: id, within: config.within,
              ...(config.denials === undefined ? {} : { denials: config.denials }),
            }
            // This conversation's own name for the person: one conversation's is no other's.
            const owner = yield* (config.ownerIn?.(id) ?? MessagesShardClient.writer(target))
            const transport = yield* MessagesShardClient.make(target)
            const { storeFor, retry, follow, limit, denials } = config
            const replica = yield* make({
              conversationId: id,
              node: nodeOf(owner, config.device),
              transport,
              ...(storeFor === undefined ? {} : { store: storeFor(id) }),
              ...(retry === undefined ? {} : { retry }),
              ...(follow === undefined ? {} : { follow }),
              ...(limit === undefined ? {} : { limit }),
              ...(denials === undefined ? {} : { denials }),
            })
            replicas.set(id, replica)
            owners.set(id, owner)
            return replica
          }).pipe(Scope.provide(scope), Effect.provideService(HttpClient.HttpClient, http))
        return MessagesShards.of({
          open: (conversationId) => Semaphore.withPermits(opening, 1)(open(conversationId.toLowerCase())),
          opened: (conversationId) => replicas.get(conversationId.toLowerCase()),
          ownerOf: (conversationId) => owners.get(conversationId.toLowerCase()),
        })
      }),
    )
}
