import {
  answerOwner as bridgeAnswerOwner,
  canonicalHash,
  type Chat,
  Chat as ChatState,
  ChatCommand,
  ChatEvent,
  decideChat,
  emptyChat,
  evolveChat,
  findMessage,
  isBridged,
  MAX_ADMITTED_POSITION,
  type Message,
  MessageCount,
  questionOwner as bridgeQuestionOwner
} from "@smthrs/app-state"
import { DoSqliteShard, type ObjectDatabase } from "@smthrs/platform-cloudflare"
import { ShardClient, ShardProtocol } from "@smthrs/sync"
import { Interactions } from "@smthrs/views"
import { Data, Effect, Option, Schema } from "effect"
import { parseMark } from "../../src/features/timeline/marks.ts"
import { FormValues } from "../../src/features/views/schema.ts"

// A conversation's messages as one event-sourced SQLite shard (decision 0170, slice 3). One Durable Object sequences
// one conversation: it assigns each accepted command the next `hubSeq` and keeps one receipt per
// `(originNodeId, commandId)`, so a retry is answered from its receipt and a reader resumes after its own cursor.
// The reducer is `decideChat` and `evolveChat` (`@smthrs/app-state`): pure, no IO and no clock.

/** The shard of conversation `conversationId`. A UUID has equivalent case spellings; the shard has one. */
export const shardOf = (conversationId: string): ShardProtocol.ShardId =>
  Schema.decodeUnknownSync(ShardProtocol.ShardId)("conv:" + conversationId.toLowerCase())

export const readCapability = (shard: ShardProtocol.ShardId) => "messages:read:" + shard
export const writeCapability = (shard: ShardProtocol.ShardId) => "messages:write:" + shard

/**
 * What every person's owner name starts with (MessagesShardRoutes.ts `personOwner`). A run's starts with its act's
 * kind. What follows the prefix names nobody: it is a keyed digest, the conversation's own.
 */
const PERSON_OWNER_PREFIX = "person:"

/** A summary as the timeline writes one (TimelineSummaries.vibe `record`): one line of 1 to 96 characters, no markup. */
const SUMMARY = /^[^\n\r<>`]{1,96}$/

/**
 * Whether the notes a command carries are ones the timeline reads: a summary in its own form, and a phase and an arc
 * that each parse as a mark (src/features/timeline/marks.ts `parseMark`, which caps a mark at 512 characters). A patch
 * may also carry an empty mark, which is a mark taken away: a patch replaces a note and never removes one, and the
 * timeline reads "" as no mark at all. A post is never born with one.
 */
const readableNotes = (payload: ChatCommand): boolean =>
  payload._tag === "UpdateMessageStatus" || payload._tag === "UpdateMessageBody" ||
  ((payload.summary === undefined || SUMMARY.test(payload.summary)) &&
    [payload.phase, payload.arc].every((mark) =>
      mark === undefined || (mark === "" && payload._tag === "UpdateMessageMetadata") || Option.isSome(parseMark(mark))))

const isEvent = Schema.is(Interactions.Name)
const valuesOf = Schema.decodeUnknownOption(Schema.fromJsonString(FormValues))

/**
 * Whether what a post says of the view it was sent from is what ChatApi stores of one (worker/Chat.ts `Question`):
 * only on a question, a view's id as Postgres prints it and an event a view can declare, and values only beside them,
 * as the JSON text of a form's values within their size (src/features/views/schema.ts `FormValues`).
 */
const readableSource = (payload: Extract<ChatCommand, { readonly _tag: "PostMessage" }>): boolean => {
  const { source, data } = payload
  if (source === undefined) return data === undefined
  return payload.role === "user" && BRIDGE_ID.test(source.viewId) && isEvent(source.event) &&
    (data === undefined || Option.isSome(valuesOf(data)))
}

/**
 * Why a submit never reached the sequencer: fixed codes, safe to log and to count by. `question` is a body update to
 * a question by the person who asked it: a question says what its post said, whoever asks to change it. `reserved` is
 * what only ChatApi's bridge writes, from anyone else: a post under a message id spelled as ChatApi's are
 * (`BRIDGE_ID`); a post that names the view it was sent from, which only ChatApi has checked against its view
 * (worker/Views.ts `askFrom`); and a message's place, its times and its notes' version (`position`, `createdAt`,
 * `updatedAt`, `noteVersion`), which are Postgres's to give. `missing` is the bridge's own write to a message the shard
 * does not hold yet: it leaves no receipt, so the same write is taken once the message is there.
 */
export const REFUSAL_REASONS = ["invalid", "wrong_shard", "origin", "person_only", "author", "question", "reserved", "missing"] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]

/**
 * Whether `message` reads as a question (src/features/chat/messagesShard.ts `rowOf`): its post said so, or a person
 * wrote it and its post said nothing.
 */
const isQuestion = (message: Message): boolean =>
  message.role === "user" || (message.role === undefined && message.author.startsWith(PERSON_OWNER_PREFIX))

/** A submit refused before sequencing: it takes no `hubSeq` and leaves no receipt. */
export class Refused extends Data.TaggedError("MessagesRefused")<{ readonly reason: RefusalReason }> {}

/**
 * Who submits, as the Worker admitted them: `author` is their owner name (MessagesShardRoutes.ts `ownerOf`), the only
 * name their messages may carry and the prefix of every node they submit from. It never contains a slash. `person` is
 * the owner name of the person a run acts for, so a run posting under it, or posting a question (`role: "user"`), is
 * named for what it tried. Only a person, acting as themselves, posts a question.
 */
export interface Writer {
  readonly author: string
  readonly person?: string
}

/**
 * One command of the backfill's batch (`backfill.batch`): the bridge's owner name it is written under, the id of its
 * key on the bridge's device, and the command. The object builds the submit itself, under its own epoch.
 */
export const BackfillCommand = Schema.Struct({ author: Schema.String, id: Schema.String, payload: Schema.Unknown })
export type BackfillCommand = typeof BackfillCommand.Type

/**
 * A batch of the backfill (worker/chat/MessagesShardBackfill.vibe): its commands in order, the Postgres `position` of
 * the last question whose commands are all in this batch or an earlier one (`cursor`), and whether the history ends
 * here (`done`).
 */
export const BackfillBatch = Schema.Struct({
  cursor: MessageCount,
  done: Schema.Boolean,
  commands: Schema.Array(BackfillCommand),
})
export type BackfillBatch = typeof BackfillBatch.Type

/**
 * Why a command of a batch was not taken: a refusal of the object (`REFUSAL_REASONS`), of the reducer
 * (`@smthrs/app-state` `CHAT_REFUSALS`), `idempotency_conflict` for an update whose key holds other content, or
 * `stale_epoch` for an epoch that kept moving. Fixed codes, safe to log and to count by.
 */
export interface BackfillRejection {
  readonly index: number
  readonly messageId: string
  readonly code: string
}

/**
 * What a batch did: how many commands were sequenced or held already (`applied`), how many posts the shard held in
 * another form (`kept`), the cursor and the mark as they stand after it, and the first command it did not take.
 */
export interface BackfillResult {
  readonly applied: number
  readonly kept: number
  readonly cursor: number
  readonly checked: boolean
  readonly rejected?: BackfillRejection
}

const Snapshot = Schema.Struct({ chat: ChatState })
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot)
const decodeEvent = Schema.decodeUnknownSync(ChatEvent)
const decodeCommand = Schema.decodeUnknownSync(ChatCommand)
const submitOf = Schema.decodeUnknownOption(Schema.fromJsonString(ShardProtocol.SubmitRequest))
const payloadOf = Schema.decodeUnknownOption(ChatCommand)

/**
 * The submit `body` holds, when it is one `submit` can read: a request of the protocol whose command is one of the
 * reducer's. The Worker forwards no other body (MessagesShardRoutes.ts `dispatch`), and reads it with the decoders
 * `submit` does.
 */
export const readSubmit = (body: string): Option.Option<ShardProtocol.SubmitRequest> =>
  Option.filter(submitOf(body), (request) => Option.isSome(payloadOf(request.command.payload)))

/** The device every command of ChatApi's bridge is submitted from, under its author's owner name. */
export const BRIDGE_DEVICE = "chatapi"

/**
 * A message id in ChatApi's namespace: a UUID in lowercase, as Postgres prints one and the bridge writes one
 * (MessagesShardBridge.ts). Every such id is the bridge's in every shard, whether or not ChatApi has stored it yet or
 * ever does, so no other writer posts under one before or after Postgres commits it, and nothing here asks Postgres
 * which ids exist. Any other spelling is another message's id.
 */
const BRIDGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The owner name question `questionId` is written under by ChatApi's bridge (`@smthrs/app-state` `questionOwner`): a
 * person's, so the message reads as a question (src/features/chat/messagesShard.ts `rowOf`), and no signed-in
 * person's, whose owner name has no `:` after its prefix (MessagesShardRoutes.ts `personOwner`). It names the question
 * and nobody: two questions one person asked share nothing a reader can see.
 */
export const questionOwner = bridgeQuestionOwner

/**
 * The owner name the pending answer `answerId` is written under by ChatApi's bridge (`@smthrs/app-state`
 * `answerOwner`): never a person's, so the answer reads as an answer, and never a run credential's, whose kinds are
 * `agent`, `flow`, `app` and `sandbox` (worker/Actor.ts `ActKind`). It names the answer and nobody.
 */
export const answerOwner = bridgeAnswerOwner

/**
 * Whether `writer` is ChatApi's bridge writing message `messageId`: no route admits a person or a run under either
 * name (MessagesShardRoutes.ts `ownerOf`).
 */
const bridges = (writer: Writer, messageId: string): boolean =>
  writer.author === questionOwner(messageId) || writer.author === answerOwner(messageId)

/** Folds one delivery into a projection. Each message records the `hubSeq` of the entry that posted it. */
export const apply = (chat: Chat, delivery: ShardClient.Delivery): Chat => {
  if (delivery._tag === "Reset") {
    return delivery.snapshot.state === null ? emptyChat : decodeSnapshot(delivery.snapshot.state).chat
  }
  return delivery.entries.reduce<Chat>(
    (state, entry) =>
      entry.events.reduce<Chat>((current, event) => evolveChat(current, entry.seq, decodeEvent(event)), state),
    chat
  )
}

/** Whether `origin` is one of the author's nodes: their name, or their name, a slash and a nonempty device. */
export const ownsOrigin = (author: string, origin: string) =>
  origin === author || (origin.length > author.length + 1 && origin.startsWith(author + "/"))

/** The owner prefix of a verified origin (an owner name never contains a slash). */
const originOwner = (origin: string) => {
  const slash = origin.indexOf("/")
  return slash === -1 ? origin : origin.slice(0, slash)
}

/**
 * `storage` with its `transactionSync` replaced. A Durable Object's storage keeps its methods on its prototype, which
 * a spread leaves behind, so `sql` is named, and `transaction`, where the storage has one, is forwarded bound to the
 * storage it belongs to: a SQL client over the result still has it for `withTransaction`.
 */
export const withTransactionSync = (
  storage: ObjectDatabase.Storage,
  transactionSync: ObjectDatabase.Storage["transactionSync"],
): ObjectDatabase.Storage => ({
  ...storage,
  sql: storage.sql,
  ...(typeof storage.transaction === "function" ? { transaction: storage.transaction.bind(storage) } : {}),
  transactionSync,
})

export const make = Effect.fnUntraced(function*(storage: ObjectDatabase.Storage, shard: ShardProtocol.ShardId) {
  // `(headSeq, chat)` is what SQLite has committed. This shard owns `storage` exclusively (never nested inside an
  // enclosing transaction), so staging in `beforeCommit` and publishing synchronously once `storage.transactionSync`
  // returns keeps `(headSeq, chat)` strictly equal to SQLite across rollbacks and concurrent fibers with no
  // cross-request lock (decision 0104).
  let chat = emptyChat
  let headSeq = 0
  const staged: Array<{ readonly chat: Chat; readonly seq: number }> = []
  const trackedStorage = withTransactionSync(storage, <T>(closure: () => T): T => {
    staged.length = 0
    try {
      const value = storage.transactionSync(closure)
      const committed = staged.pop()
      if (committed !== undefined) {
        chat = committed.chat
        headSeq = committed.seq
      }
      return value
    } finally {
      staged.length = 0
    }
  })
  const { shard: journal } = yield* DoSqliteShard.make(trackedStorage, {
    shard,
    // Inside `transactionSync`, after `StaleEpoch` and receipt checks: a status, metadata or body update for an existing
    // message owned by another author rolls back with no receipt and no `hubSeq`; an update for a missing message
    // proceeds to `decideChat`, which refuses it with a receipt. A body update to a question is refused before any
    // author is compared, the one the update claims included, and named for who tried: a run (`person_only`), or the
    // person who asked it (`question`). Only then is a body update held to the admitted writer's own name.
    //
    // The bridge's own update is the exception to the missing message: Postgres holds the message, so the shard will,
    // and a receipt that said `message_missing` would answer the same note for ever. It rolls back with no receipt
    // (`missing`), and the note sent again after its message is taken.
    decide: (command) => {
      const payload = decodeCommand(command.payload)
      if (payload._tag !== "PostMessage") {
        const owner = originOwner(command.key[0])
        const target = findMessage(chat, payload.messageId)
        if (target === undefined && bridges({ author: owner }, payload.messageId)) throw new Refused({ reason: "missing" })
        if (payload._tag === "UpdateMessageBody") {
          if (target !== undefined && isQuestion(target)) {
            if (!owner.startsWith(PERSON_OWNER_PREFIX)) throw new Refused({ reason: "person_only" })
            if (owner === target.author) throw new Refused({ reason: "question" })
          }
          if (payload.author !== owner) throw new Refused({ reason: "author" })
        }
        if (target !== undefined && target.author !== owner) throw new Refused({ reason: "author" })
      }
      return decideChat(chat, payload)
    },
    beforeCommit: (entry) => {
      staged.push({
        chat: apply(chat, { _tag: "Entries", entries: [entry], through: { shard, epoch: entry.epoch, seq: entry.seq } }),
        seq: entry.seq
      })
    }
  })
  const reader = yield* ShardClient.make({
    shard,
    node: "authority",
    transport: journal,
    store: ShardClient.memoryStore(),
    apply: (delivery) => Effect.sync(() => {
      chat = apply(chat, delivery)
      headSeq = delivery._tag === "Reset" ? delivery.snapshot.position.seq : delivery.through.seq
    })
  })
  // Rebuild the reducer from the durable snapshot and tail before admitting requests.
  yield* reader.pull.pipe(Effect.orDie)
  const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)
  // Whether the conversation's history in Postgres has been replayed into this shard (decision 0170, slice 5b;
  // worker/chat/MessagesShardBackfill.vibe). One row, in this object's own SQLite beside the journal, so a storage
  // that loses the journal loses the mark with it. A shard's head says nothing of this: a shard can hold only the
  // writes the bridge sent since it started, and none of what Postgres held before.
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS messages_shard_backfill (id INTEGER PRIMARY KEY CHECK (id = 1), checked_at INTEGER NOT NULL)"
  )
  // How far the backfill got: the Postgres `position` of the last question whose commands all reached an answer that
  // stands. Written in the transaction that sets the mark, and never lowered, so a backfill cut short resumes after it.
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS messages_shard_backfill_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), cursor INTEGER NOT NULL)"
  )
  // Where Postgres put a message the bridge posted before posts carried a place (slice 4c). Its post stands, and no
  // event changes an origin, so the place the backfill read for it is kept here and given to every reader with its
  // post (`placed`): mixed history reads in Postgres's order.
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS messages_shard_positions (message_id TEXT PRIMARY KEY, position INTEGER NOT NULL)"
  )
  const exec = <T>(query: string, ...bindings: Array<unknown>): Array<T> =>
    storage.sql.exec(query, ...bindings).toArray() as unknown as Array<T>
  const checkedNow = () => exec("SELECT id FROM messages_shard_backfill WHERE id = 1").length > 0
  const cursorNow = () => exec<{ readonly cursor: number }>("SELECT cursor FROM messages_shard_backfill_cursor WHERE id = 1")[0]?.cursor ?? 0

  /** Request-scoped refusals that depend only on the admitted writer and command, never on mutable state. */
  const refusal = (writer: Writer, command: ShardProtocol.Command, payload: ChatCommand): RefusalReason | undefined => {
    if (!ownsOrigin(writer.author, command.key[0])) return "origin"
    if (payload._tag === "PostMessage") {
      // An id in ChatApi's namespace is posted by the bridge's writer for that message and nobody else. No route admits
      // a person or a run under a bridge owner name (MessagesShardRoutes.ts `ownerOf`), so the refusal needs nothing
      // but the command: it is the same in every shard, before and after ChatApi stores the id.
      if (BRIDGE_ID.test(payload.messageId) && !bridges(writer, payload.messageId)) return "reserved"
      // The view a question was sent from, and its values, are ChatApi's to say: it checked them against the view.
      if ((payload.source !== undefined || payload.data !== undefined) && writer.author !== questionOwner(payload.messageId)) {
        return "reserved"
      }
      // A question is a person's own: a run, whoever it acts for, never posts a message that reads as one, even when naming someone else.
      if (payload.role === "user" && (!writer.author.startsWith(PERSON_OWNER_PREFIX) || writer.person !== undefined)) {
        return "person_only"
      }
    }
    // Where a message reads, when it was made and last written, and which write of its notes this is, are Postgres's:
    // only the bridge, which read them from the committed row, says them. Anyone else's post is placed by the shard's
    // own sequence, and nobody else backdates a row or moves it among earlier ones (`@smthrs/app-state` `placesOf`).
    if (
      (payload._tag === "PostMessage" || payload._tag === "UpdateMessageMetadata") &&
      ((payload._tag === "PostMessage" && (payload.position !== undefined || payload.createdAt !== undefined)) ||
        payload.updatedAt !== undefined || payload.noteVersion !== undefined) &&
      !bridges(writer, payload.messageId)
    ) {
      return "reserved"
    }
    // A place past the ceiling a reader admits is no place (`@smthrs/app-state` `placeOf`): Postgres never gives one,
    // and none is journaled, so every place a reader derives adds exactly.
    if (payload._tag === "PostMessage" && payload.position !== undefined && payload.position > MAX_ADMITTED_POSITION) {
      return "invalid"
    }
    // A post and a body update name who writes: only the admitted writer, never the person a run acts for, which is
    // named before any other author is. Any other name on a post is refused here. On a body update it is refused in
    // `decide`, once the message it reaches for is known not to be a question a run may never touch; the reducer then
    // holds the update to the message's own author.
    if ((payload._tag === "PostMessage" || payload._tag === "UpdateMessageBody") && payload.author !== writer.author) {
      if (payload.author === writer.person) return "person_only"
      if (payload._tag === "PostMessage") return "author"
    }
    if (!readableNotes(payload) || (payload._tag === "PostMessage" && !readableSource(payload))) return "invalid"
    return undefined
  }

  /**
   * Sequences `request` for `writer`. The answer is the protocol's: `Accepted`, `Duplicate`, `Refused` (the reducer's
   * reason, kept as the key's receipt), `StaleEpoch` or `IdempotencyConflict`.
   */
  const admit = (writer: Writer, request: ShardProtocol.SubmitRequest) =>
    Effect.gen(function*() {
      if (request.shard !== shard || request.command.stream !== stream) {
        return yield* new Refused({ reason: "wrong_shard" })
      }
      const decoded = payloadOf(request.command.payload)
      if (Option.isNone(decoded)) return yield* new Refused({ reason: "invalid" })
      const payload = decoded.value
      const reason = refusal(writer, request.command, payload)
      if (reason !== undefined) return yield* new Refused({ reason })
      // The journal sequences and hashes the decoded payload, which holds the schema's fields and nothing else:
      // whatever else the body carried is never walked, stored or sent on.
      return yield* journal.submit({ ...request, command: { ...request.command, payload } }).pipe(
        Effect.orDie,
        Effect.catchDefect((defect) => (defect instanceof Refused ? Effect.fail(defect) : Effect.die(defect)))
      )
    })

  /**
   * Keeps the place Postgres gave a message the shard holds as the bridge posted it with none (slice 4c), once: a post
   * of the backfill's that names a place, answered `IdempotencyConflict` because its key holds that older post.
   */
  const reconcile = (payload: Extract<ChatCommand, { readonly _tag: "PostMessage" }>) => {
    const held = findMessage(chat, payload.messageId)
    // A post whose key holds a refusal, or another writer's message, or a message with a place: nothing to keep.
    const unplaced = held !== undefined && isBridged(held) && held.position === undefined
    if (unplaced && payload.position !== undefined) {
      exec("INSERT OR IGNORE INTO messages_shard_positions (message_id, position) VALUES (?, ?)", payload.messageId, payload.position)
    }
  }

  /**
   * One command of a batch, as the bridge would send it (worker/chat/MessagesShardBridge.ts `sequence`): under the
   * shard's own epoch, once more under the one a `StaleEpoch` names, and once more under a key no `message_missing`
   * receipt holds. `ok` when it was sequenced or held already, `kept` for a post the shard holds in another form,
   * which stands, and otherwise the code of why it was not taken.
   */
  const backfillOne = (command: BackfillCommand) =>
    Effect.gen(function*() {
      const decoded = payloadOf(command.payload)
      if (Option.isNone(decoded)) return "invalid"
      const payload = decoded.value
      const writer = { author: command.author }
      const send = (id: string, epoch: number) =>
        admit(writer, {
          version: ShardProtocol.protocolVersion,
          shard,
          epoch,
          command: { key: [`${command.author}/${BRIDGE_DEVICE}`, id], stream, payload },
        })
      const settle = (id: string): Effect.Effect<string, Refused> =>
        Effect.gen(function*() {
          // The epoch is read here and the submit is decided in the same turn: nothing between them moves it.
          const answer = yield* send(id, (yield* journal.head).epoch)
          if (answer._tag === "IdempotencyConflict") {
            if (payload._tag === "PostMessage") reconcile(payload)
            return "kept"
          }
          if (answer._tag === "Refused") {
            // A receipt that says the message was missing answers its key for ever: the message may be there now.
            if (answer.reason === "message_missing" && !id.endsWith(":again")) return yield* settle(`${id}:again`)
            return KEPT_REFUSALS.has(answer.reason) ? "kept" : answer.reason
          }
          return SETTLED[answer._tag]
        })
      return yield* settle(command.id).pipe(Effect.catch((refused) => Effect.succeed(refused.reason)))
    })

  /** What a batch's command came to, by the protocol's answer: taken, or an epoch that kept moving. */
  const SETTLED = { Accepted: "ok", Duplicate: "ok", StaleEpoch: "stale_epoch" } as const
  /**
   * Reducer refusals that mean the shard already holds a frozen terminal or diverged state for the message
   * (matching MessagesShardSource.ts SETTLED). Treating them as kept prevents an out-of-order receipt or
   * post-bridge row edit from permanently locking backfill at 503.
   */
  const KEPT_REFUSALS: ReadonlySet<string> = new Set([
    "terminal_status",
    "terminal_metadata",
    "terminal_body",
    "body_conflict",
  ])

  /** The places `messages_shard_positions` keeps, by message id. */
  const positions = () =>
    new Map(exec<{ readonly message_id: string; readonly position: number }>(
      "SELECT message_id, position FROM messages_shard_positions"
    ).map((row) => [row.message_id, row.position]))
  /** `message`, a post or a message as Json, with the place kept for it when its post named none. */
  const placed = (kept: ReadonlyMap<string, number>) => <A>(message: A): A => {
    const { id, position } = message as { readonly id: string; readonly position?: number }
    const place = position === undefined ? kept.get(id) : undefined
    return place === undefined ? message : { ...message, position: place }
  }

  return {
    shard,
    /** Sequences the submit request in `body` for `writer` (`admit`). */
    submit: (writer: Writer, body: string) =>
      Effect.gen(function*() {
        const read = submitOf(body)
        if (Option.isNone(read)) return yield* new Refused({ reason: "invalid" })
        return yield* admit(writer, read.value)
      }),
    /**
     * The journal as readers are given it: every post of a message whose place the backfill kept
     * (`messages_shard_positions`) carries that place, in a Pull's entries and a Snapshot's state alike.
     */
    journal: {
      pull: (request: ShardProtocol.PullRequest) =>
        Effect.map(journal.pull(request), (answer): ShardProtocol.PullResponse => {
          const kept = positions()
          if (answer._tag !== "Page" || kept.size === 0) return answer
          const place = placed(kept)
          return {
            ...answer,
            entries: answer.entries.map((entry) => ({
              ...entry,
              events: entry.events.map((event) => (event as { readonly _tag: string })._tag === "MessagePosted" ? place(event) : event),
            })),
          }
        }),
      snapshot: (requested: ShardProtocol.ShardId) =>
        Effect.map(journal.snapshot(requested), (answer): ShardProtocol.SnapshotResponse => {
          const kept = positions()
          const state = answer.state as { readonly chat: { readonly messages: ReadonlyArray<Schema.Json> } } | null
          if (state === null || kept.size === 0) return answer
          return { ...answer, state: { ...state, chat: { ...state.chat, messages: state.chat.messages.map(placed(kept)) } } }
        }),
      head: journal.head,
    },
    /**
     * The backfill's mark and cursor: `checked` is whether every command of the conversation's history reached an
     * answer that stands, and `check` records that, once. Checking again keeps the first time. `cursor` is how far
     * the backfill got (`BackfillBatch.cursor`), 0 before it started.
     *
     * `batch` applies a batch of the backfill in order, as the bridge would (`backfillOne`), and stops at the first
     * command not taken: nothing after it is sent, and the cursor and the mark stay as they were. Each command is its
     * own transaction, under its key's receipt, so a batch cut short and sent again adds nothing. Once every command
     * is taken, one transaction raises the cursor to the batch's, never lowers it, and on the last batch sets the
     * mark.
     */
    backfill: {
      checked: Effect.sync(checkedNow),
      cursor: Effect.sync(cursorNow),
      check: Effect.sync(() => {
        exec("INSERT OR IGNORE INTO messages_shard_backfill (id, checked_at) VALUES (1, ?)", Date.now())
      }),
      batch: (batch: BackfillBatch): Effect.Effect<BackfillResult> =>
        Effect.gen(function*() {
          let applied = 0
          let kept = 0
          for (const [index, command] of batch.commands.entries()) {
            const outcome = yield* backfillOne(command)
            if (outcome === "ok") applied++
            else if (outcome === "kept") kept++
            else {
              // A message's id, or none for a command that is no command: never anything else of it.
              const messageId = Option.getOrElse(Option.map(payloadOf(command.payload), (payload) => payload.messageId), () => "")
              return { applied, kept, cursor: cursorNow(), checked: checkedNow(), rejected: { index, messageId, code: outcome } }
            }
          }
          storage.transactionSync(() => {
            exec(
              `INSERT INTO messages_shard_backfill_cursor (id, cursor) VALUES (1, ?)
               ON CONFLICT(id) DO UPDATE SET cursor = max(cursor, excluded.cursor)`,
              batch.cursor
            )
            if (batch.done) exec("INSERT OR IGNORE INTO messages_shard_backfill (id, checked_at) VALUES (1, ?)", Date.now())
          })
          return { applied, kept, cursor: cursorNow(), checked: checkedNow() }
        }),
    },
    state: Effect.sync(() => ({ chat, hash: canonicalHash(chat) })),
    compact: Effect.suspend(() => journal.compact(headSeq, { chat }).pipe(Effect.orDie))
  }
})

export type LiveMessages = Effect.Success<ReturnType<typeof make>>
