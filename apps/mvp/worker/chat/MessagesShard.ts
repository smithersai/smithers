import {
  canonicalHash,
  type Chat,
  Chat as ChatState,
  ChatCommand,
  ChatEvent,
  decideChat,
  emptyChat,
  evolveChat,
  findMessage,
  type Message
} from "@smthrs/app-state"
import { DoSqliteShard, type ObjectDatabase } from "@smthrs/platform-cloudflare"
import { ShardClient, ShardProtocol } from "@smthrs/sync"
import { Data, Effect, Option, Schema } from "effect"
import { parseMark } from "../../src/features/timeline/marks.ts"

// A conversation's messages as one event-sourced SQLite shard (decision 0170, slice 3). One Durable Object sequences
// one conversation: it assigns each accepted command the next `hubSeq` and keeps one receipt per
// `(originNodeId, commandId)`, so a retry is answered from its receipt and a reader resumes after its own cursor.
// The reducer is `decideChat` and `evolveChat` (`@smthrs/app-state`): pure, no IO and no clock.

/** The shard of conversation `conversationId`. A UUID has equivalent case spellings; the shard has one. */
export const shardOf = (conversationId: string): ShardProtocol.ShardId =>
  Schema.decodeUnknownSync(ShardProtocol.ShardId)("conv:" + conversationId.toLowerCase())

export const readCapability = (shard: ShardProtocol.ShardId) => "messages:read:" + shard
export const writeCapability = (shard: ShardProtocol.ShardId) => "messages:write:" + shard

/** What every person's owner name starts with (MessagesShardRoutes.ts `personOwner`). A run's starts with its act's kind. */
const PERSON_OWNER_PREFIX = "person:"

/** A summary as the timeline writes one (TimelineSummaries.vibe `record`): one line of 1 to 96 characters, no markup. */
const SUMMARY = /^[^\n\r<>`]{1,96}$/

/**
 * Whether the notes a command carries are ones the timeline reads: a summary in its own form, and a phase and an arc
 * that each parse as a mark (src/features/timeline/marks.ts `parseMark`, which caps a mark at 512 characters).
 */
const readableNotes = (payload: ChatCommand): boolean =>
  payload._tag === "UpdateMessageStatus" || payload._tag === "UpdateMessageBody" ||
  ((payload.summary === undefined || SUMMARY.test(payload.summary)) &&
    [payload.phase, payload.arc].every((mark) => mark === undefined || Option.isSome(parseMark(mark))))

/**
 * Why a submit never reached the sequencer: fixed codes, safe to log and to count by. `question` is a body update to
 * a question by the person who asked it: a question says what its post said, whoever asks to change it. `reserved` is
 * a post under a message id spelled as ChatApi's are (`BRIDGE_ID`) by anyone but the bridge's writer for that message.
 */
export const REFUSAL_REASONS = ["invalid", "wrong_shard", "origin", "person_only", "author", "question", "reserved"] as const
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

const Snapshot = Schema.Struct({ chat: ChatState })
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot)
const decodeEvent = Schema.decodeUnknownSync(ChatEvent)
const decodeCommand = Schema.decodeUnknownSync(ChatCommand)
const submitOf = Schema.decodeUnknownOption(Schema.fromJsonString(ShardProtocol.SubmitRequest))
const payloadOf = Schema.decodeUnknownOption(ChatCommand)

/**
 * Whether `body` is a submit `submit` can read: a request of the protocol whose command is one of the reducer's. The
 * Worker forwards no other body (MessagesShardRoutes.ts `dispatch`), and reads it with the decoders `submit` does.
 */
export const decodes = (body: string): boolean =>
  Option.isSome(Option.flatMap(submitOf(body), (request) => payloadOf(request.command.payload)))

/**
 * A message id in ChatApi's namespace: a UUID in lowercase, as Postgres prints one and the bridge writes one
 * (MessagesShardBridge.ts). Every such id is the bridge's in every shard, whether or not ChatApi has stored it yet or
 * ever does, so no other writer posts under one before or after Postgres commits it, and nothing here asks Postgres
 * which ids exist. Any other spelling is another message's id.
 */
const BRIDGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The owner name question `questionId` is written under by ChatApi's bridge: a person's, so the message reads as a
 * question (src/features/chat/messagesShard.ts `rowOf`), and no signed-in person's, whose owner name has no `:` after
 * its prefix (MessagesShardRoutes.ts `personOwner`). It names the question and nobody: two questions one person asked
 * share nothing a reader can see.
 */
export const questionOwner = (questionId: string): string => `${PERSON_OWNER_PREFIX}question:${questionId}`

/**
 * The owner name the pending answer `answerId` is written under by ChatApi's bridge: never a person's, so the answer
 * reads as an answer, and never a run credential's, whose kinds are `agent`, `flow`, `app` and `sandbox`
 * (worker/Actor.ts `ActKind`). It names the answer and nobody.
 */
export const answerOwner = (answerId: string): string => `answer:${answerId}`

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
    decide: (command) => {
      const payload = decodeCommand(command.payload)
      if (payload._tag !== "PostMessage") {
        const owner = originOwner(command.key[0])
        const target = findMessage(chat, payload.messageId)
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

  /** Request-scoped refusals that depend only on the admitted writer and command, never on mutable state. */
  const refusal = (writer: Writer, command: ShardProtocol.Command, payload: ChatCommand): RefusalReason | undefined => {
    if (!ownsOrigin(writer.author, command.key[0])) return "origin"
    if (payload._tag === "PostMessage") {
      // An id in ChatApi's namespace is posted by the bridge's writer for that message and nobody else. No route admits
      // a person or a run under a bridge owner name (MessagesShardRoutes.ts `ownerOf`), so the refusal needs nothing
      // but the command: it is the same in every shard, before and after ChatApi stores the id.
      if (
        BRIDGE_ID.test(payload.messageId) &&
        writer.author !== questionOwner(payload.messageId) && writer.author !== answerOwner(payload.messageId)
      ) {
        return "reserved"
      }
      // A question is a person's own: a run, whoever it acts for, never posts a message that reads as one, even when naming someone else.
      if (payload.role === "user" && (!writer.author.startsWith(PERSON_OWNER_PREFIX) || writer.person !== undefined)) {
        return "person_only"
      }
    }
    // A post and a body update name who writes: only the admitted writer, never the person a run acts for, which is
    // named before any other author is. Any other name on a post is refused here. On a body update it is refused in
    // `decide`, once the message it reaches for is known not to be a question a run may never touch; the reducer then
    // holds the update to the message's own author.
    if ((payload._tag === "PostMessage" || payload._tag === "UpdateMessageBody") && payload.author !== writer.author) {
      if (payload.author === writer.person) return "person_only"
      if (payload._tag === "PostMessage") return "author"
    }
    if (!readableNotes(payload)) return "invalid"
    return undefined
  }

  return {
    shard,
    /**
     * Sequences the submit request in `body` for `writer`. The answer is the protocol's: `Accepted`, `Duplicate`,
     * `Refused` (the reducer's reason, kept as the key's receipt), `StaleEpoch` or `IdempotencyConflict`.
     */
    submit: (writer: Writer, body: string) =>
      Effect.gen(function*() {
        const read = submitOf(body)
        if (Option.isNone(read)) return yield* new Refused({ reason: "invalid" })
        const request = read.value
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
      }),
    journal: { pull: journal.pull, snapshot: journal.snapshot, head: journal.head },
    state: Effect.sync(() => ({ chat, hash: canonicalHash(chat) })),
    compact: Effect.suspend(() => journal.compact(headSeq, { chat }).pipe(Effect.orDie))
  }
})

export type LiveMessages = Effect.Success<ReturnType<typeof make>>
