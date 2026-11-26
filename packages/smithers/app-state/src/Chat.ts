/**
 * Chat messages: append-only, idempotent by message id, conflict-refusing.
 *
 * Mirrors `lean/smithers-state/SmithersState/Chat.lean`. A message records the
 * `hubSeq` of the commit that appended it; 0 means "optimistic, not yet committed".
 *
 * A message's `body` only grows. `UpdateMessageBody` carries the whole body its author has so far, and is accepted
 * only when that body extends the stored one, so a run that streams an answer resends everything it has after a crash
 * and a late or repeated update changes nothing. Only the message's own author extends it, never once its status is
 * terminal, and never when it is a question (`role: "user"`): a person's question says what its post said.
 *
 * Besides `id`, `author`, `body`, `status`, and `hubSeq`, a message carries three
 * groups of optional fields. An absent field is absent from the canonical JSON,
 * so a message, command, event, or snapshot written before the groups existed
 * decodes and hashes exactly as it did.
 *
 * - origin (`role`, `questionId`, `position`, `createdAt`, `source`, `data`): set by the post, never changed.
 * - run (`parts`, `failure`, `modelId`, `stopReason`, `inputTokens`, `outputTokens`):
 *   written while the message streams, frozen once its status is terminal.
 * - notes (`summary`, `summaryRevision`, `phase`, `arc`, `updatedAt`, `noteVersion`): written at any time.
 *
 * A post may carry its message's first run and notes fields, so a message and what is known of it at birth are one
 * command and one event: a post the reducer refuses writes none of them.
 *
 * Every added string and list is bounded here, at the Schema boundary, so nothing longer is ever decided, journaled
 * or hashed. Lean models the fields as unbounded `String` and `List`: a bound narrows the input, never a decision.
 * A command's body, a post's as much as a body update's, is bounded and whole Unicode text too. A stored message and a
 * posted event keep the unbounded `body` they always had, so a journal written before the bound still decodes.
 *
 * A message's place among its conversation's is `placesOf`, the one rule every reader orders by and the twin of Lean's
 * `Chat.places`. Only ChatApi's bridge places a message: a `position` counts when the message's author is the bridge's
 * owner name for its id (`questionOwner`, `answerOwner`), and is ignored from anyone else. Any other message is anchored
 * where the shard sequenced it, never before a message that was already there. One movement is permitted, for a shard
 * written before posts carried a position: a bridge answer posted with none reads straight after its bridge question
 * once that question, with its position, is posted. No event changes a message's origin, and nothing else moves one.
 *
 * Notes carry a `noteVersion` when the bridge writes them: which write of the notes this is, counted where they are
 * kept. A patch whose version is no newer than the stored one changes nothing, so a delayed older note never replaces
 * a newer one.
 */
import * as Schema from "effect/Schema"
import { canonicalJson } from "./Canonical.ts"
import { accepted, type Decision, refused } from "./Decision.ts"

export const MessageStatus = Schema.Literals(["posted", "streaming", "complete", "failed"])
export type MessageStatus = typeof MessageStatus.Type

export const MessageRole = Schema.Literals(["user", "assistant"])
export type MessageRole = typeof MessageRole.Type

export const MessageFailure = Schema.Literals([
  "quota",
  "rate_limited",
  "model_error",
  "empty",
  "abandoned",
  "unfinished"
])
export type MessageFailure = typeof MessageFailure.Type

/** A count or a position. Lean models it as `Nat`, so the wire refuses negatives and fractions. */
export const MessageCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** The longest summary: the timeline's own cap on the line it writes and shows. */
export const MAX_SUMMARY_LENGTH = 96
/** The longest phase or arc: the timeline reads nothing longer as a mark. */
export const MAX_MARK_LENGTH = 512
/** The most steps one answer records. */
export const MAX_PARTS = 64
/** The longest id, flow name, model name, stop reason, revision or timestamp. */
export const MAX_LABEL_LENGTH = 256
/** The longest body a body update writes, in UTF-16 code units: the longest answer an attached agent gives. */
export const MAX_BODY_LENGTH = 32_000
/**
 * The most bytes a streamed body takes on the wire, as a JSON string in UTF-8: a UTF-16 code unit is at most three
 * bytes written as itself and six written as an escape (`\u0001`), between two quotes. A route that carries a body
 * update admits this many bytes for the body, and its envelope besides, so no body the reducer takes is refused for
 * the size of its encoding.
 */
export const MAX_BODY_WIRE_BYTES = MAX_BODY_LENGTH * 6 + 2
/** The longest `data` a post carries, in UTF-16 code units: a view's values as JSON text (16 KiB of ASCII). */
export const MAX_DATA_LENGTH = 16_384

const Label = Schema.String.check(Schema.isMaxLength(MAX_LABEL_LENGTH))
const Mark = Schema.String.check(Schema.isMaxLength(MAX_MARK_LENGTH))
/** A surrogate with no partner. With the `u` flag a paired surrogate is one code point and never matches. */
const LONE_SURROGATE = /\p{Cs}/u
const isWhole = Schema.makeFilter((text: string) => !LONE_SURROGATE.test(text))
/**
 * A body a command writes, a post's or a body update's: bounded, and whole Unicode text. A lone surrogate is refused,
 * so "extends" means the same in UTF-16 here and in code points in Lean, and a body is the same text in UTF-8.
 */
const StreamedBody = Schema.String.check(Schema.isMaxLength(MAX_BODY_LENGTH), isWhole)
const WholeLabel = Label.check(isWhole)

/** The view a question was sent from, and the view's event that sent it. */
export const MessageSource = Schema.Struct({ viewId: WholeLabel, event: WholeLabel })
export type MessageSource = typeof MessageSource.Type

/** One step an answer took: the flow it called and how the call went. */
export const MessagePart = Schema.Struct({
  id: Label,
  kind: Schema.Literal("step"),
  flow: Label,
  status: Schema.Literals(["running", "done", "failed"])
})
export type MessagePart = typeof MessagePart.Type

const originFields = {
  role: Schema.optionalKey(MessageRole),
  /** On an answer: the id of the question it answers. */
  questionId: Schema.optionalKey(Label),
  /** The message's place in its conversation, when the poster assigns one. */
  position: Schema.optionalKey(MessageCount),
  /** When the poster made it. The reducer has no clock: it stores what the command says. */
  createdAt: Schema.optionalKey(Label),
  /** On a question sent from a view: the view and its event. */
  source: Schema.optionalKey(MessageSource),
  /** The values sent with a question from a view, as JSON text. The reducer stores the text and never reads it. */
  data: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_DATA_LENGTH), isWhole))
}
const runFields = {
  parts: Schema.optionalKey(Schema.Array(MessagePart).check(Schema.isMaxLength(MAX_PARTS))),
  failure: Schema.optionalKey(MessageFailure),
  modelId: Schema.optionalKey(Label),
  stopReason: Schema.optionalKey(Label),
  inputTokens: Schema.optionalKey(MessageCount),
  outputTokens: Schema.optionalKey(MessageCount)
}
const notesFields = {
  summary: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_SUMMARY_LENGTH))),
  summaryRevision: Schema.optionalKey(Label),
  /** The phase, then the arc, that starts at this message, as JSON text. */
  phase: Schema.optionalKey(Mark),
  arc: Schema.optionalKey(Mark),
  updatedAt: Schema.optionalKey(Label),
  /** Which write of the notes this is. A patch that carries one no newer than the stored one changes nothing. */
  noteVersion: Schema.optionalKey(MessageCount)
}

/** What a post sets once. */
export const MessageOrigin = Schema.Struct(originFields)
export type MessageOrigin = typeof MessageOrigin.Type

/** What a run writes while its message streams. Frozen once the status is terminal. */
export const MessageRun = Schema.Struct(runFields)
export type MessageRun = typeof MessageRun.Type

/** What anyone may still write once the message is terminal. */
export const MessageNotes = Schema.Struct(notesFields)
export type MessageNotes = typeof MessageNotes.Type

/** A metadata patch: each field it has replaces the message's, each field it lacks leaves the message's. */
export const MessageMetadata = Schema.Struct({ ...runFields, ...notesFields })
export type MessageMetadata = typeof MessageMetadata.Type

export const Message = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
  status: MessageStatus,
  hubSeq: Schema.Int,
  ...originFields,
  ...runFields,
  ...notesFields
})
export type Message = typeof Message.Type

export const Chat = Schema.Struct({ messages: Schema.Array(Message) })
export type Chat = typeof Chat.Type

export const emptyChat: Chat = { messages: [] }

export const PostMessage = Schema.TaggedStruct("PostMessage", {
  messageId: Schema.String,
  author: Schema.String,
  body: StreamedBody,
  ...originFields,
  ...runFields,
  ...notesFields
})
export const UpdateMessageStatus = Schema.TaggedStruct("UpdateMessageStatus", {
  messageId: Schema.String,
  status: MessageStatus
})
export const UpdateMessageMetadata = Schema.TaggedStruct("UpdateMessageMetadata", {
  messageId: Schema.String,
  ...runFields,
  ...notesFields
})
/**
 * The whole body `author` has written of its message so far. `author` is who submits it, as the shard admitted them:
 * the reducer refuses anyone but the message's own author.
 */
export const UpdateMessageBody = Schema.TaggedStruct("UpdateMessageBody", {
  messageId: Schema.String,
  author: Schema.String,
  body: StreamedBody
})
export const ChatCommand = Schema.Union([PostMessage, UpdateMessageStatus, UpdateMessageMetadata, UpdateMessageBody])
export type ChatCommand = typeof ChatCommand.Type

export const MessagePosted = Schema.TaggedStruct("MessagePosted", {
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
  ...originFields,
  ...runFields,
  ...notesFields
})
export const MessageStatusUpdated = Schema.TaggedStruct("MessageStatusUpdated", {
  id: Schema.String,
  status: MessageStatus
})
export const MessageMetadataUpdated = Schema.TaggedStruct("MessageMetadataUpdated", {
  id: Schema.String,
  ...runFields,
  ...notesFields
})
export const MessageBodyUpdated = Schema.TaggedStruct("MessageBodyUpdated", {
  id: Schema.String,
  body: StreamedBody
})
export const ChatEvent = Schema.Union([MessagePosted, MessageStatusUpdated, MessageMetadataUpdated, MessageBodyUpdated])
export type ChatEvent = typeof ChatEvent.Type

/** Every reason the reducer refuses a command for: fixed codes, safe to log and to count by. */
export const CHAT_REFUSALS = [
  "message_conflict",
  "message_missing",
  "terminal_status",
  "terminal_metadata",
  "body_question",
  "body_author",
  "terminal_body",
  "body_conflict"
] as const
export type ChatRefusal = (typeof CHAT_REFUSALS)[number]

const ORIGIN_KEYS = Object.keys(originFields) as ReadonlyArray<keyof MessageOrigin>
const RUN_KEYS = Object.keys(runFields) as ReadonlyArray<keyof MessageRun>
const METADATA_KEYS = [...RUN_KEYS, ...Object.keys(notesFields)] as ReadonlyArray<keyof MessageMetadata>

/**
 * The `keys` of `source` that hold a value, each copied, so the result never
 * aliases its source and an explicit `undefined` never overwrites a field.
 */
const pick = <A extends object>(keys: ReadonlyArray<keyof A>, source: A): A => {
  const out: { -readonly [K in keyof A]?: A[K] } = {}
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined) out[key] = structuredClone(value)
  }
  return out as A
}

/** The origin fields `source` holds: a message's, a post's, or a posted event's. */
export const originOf = (source: MessageOrigin): MessageOrigin => pick(ORIGIN_KEYS, source)

/** The run fields `source` holds. */
export const runOf = (source: MessageRun): MessageRun => pick(RUN_KEYS, source)

/** The run and notes fields `source` holds: a message's, an update's, or an updated event's. */
export const metadataOf = (source: MessageMetadata): MessageMetadata => pick(METADATA_KEYS, source)

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right)

/**
 * The owner name ChatApi's bridge writes question `questionId` under, and no one else: a person's, so the message reads
 * as a question, and no signed-in person's. It names the question and nobody.
 */
export const questionOwner = (questionId: string): string => `person:question:${questionId}`

/** The owner name ChatApi's bridge writes answer `answerId` under, and no one else. It names the answer and nobody. */
export const answerOwner = (answerId: string): string => `answer:${answerId}`

/** Whether the bridge posted `message`: its author is the bridge's owner name for its own id. */
export const isBridged = (message: Pick<Message, "id" | "author">): boolean =>
  message.author === questionOwner(message.id) || message.author === answerOwner(message.id)

/**
 * The highest `position` a reader admits (`2 ** 50`), the twin of Lean's `maxAdmittedPosition`. Every place is a
 * position, a `hubSeq` or a floor one or two past one, so under this ceiling `placesOf` adds exactly: a double steps
 * by one up to `2 ** 53`, and Lean's `Nat` agrees with it on every admitted position. A higher position is no
 * position at all, whoever posted it; the shard also refuses a post that names one (worker/chat/MessagesShard.ts).
 */
export const MAX_ADMITTED_POSITION = 2 ** 50

/** The `position` a post named, when a reader admits it (Lean's `MessageOrigin.place`). */
export const placeOf = (origin: Pick<MessageOrigin, "position">): number | undefined =>
  origin.position !== undefined && origin.position <= MAX_ADMITTED_POSITION ? origin.position : undefined

/**
 * Where each of `messages` reads, in the order given (the order the chat holds them). Readers sort by it, and among
 * equal places by the order the chat holds. The twin of Lean's `placesOf`. A `position` below is an admitted one
 * (`placeOf`):
 * - a message the bridge posted with a `position` reads there;
 * - a bridge answer posted with no position reads one past its bridge question's position, once that question holds
 *   one (the permitted movement);
 * - any other message is anchored at its `hubSeq`, and never below the floor: one past the highest anchor before it,
 *   and two past a bridge question's position, whose next place is its answer's. A `position` its post carries is
 *   ignored.
 */
export const placesOf = (messages: ReadonlyArray<Message>): ReadonlyArray<number> => {
  let floor = 0
  const anchors = messages.map((message) => {
    const anchor = (isBridged(message) ? placeOf(message) : undefined) ?? Math.max(message.hubSeq, floor)
    const placed = message.author === questionOwner(message.id) && placeOf(message) !== undefined
    floor = Math.max(floor, anchor + (placed ? 2 : 1))
    return anchor
  })
  return messages.map((message, index) => {
    if (message.author !== answerOwner(message.id) || placeOf(message) !== undefined) return anchors[index]!
    const asked = message.questionId
    const question = asked === undefined
      ? undefined
      : messages.find((other) => other.id === asked && other.author === questionOwner(asked))
    const place = question === undefined ? undefined : placeOf(question)
    return place === undefined ? anchors[index]! : place + 1
  })
}

export const findMessage = (chat: Chat, id: string): Message | undefined =>
  chat.messages.find((message) => message.id === id)

/** A terminal status is never overwritten by a later, stale update. */
export const isTerminal = (status: MessageStatus): boolean => status === "complete" || status === "failed"

export const decideChat = (chat: Chat, command: ChatCommand): Decision<ChatEvent, ChatRefusal> => {
  switch (command._tag) {
    case "PostMessage": {
      const existing = findMessage(chat, command.messageId)
      const origin = originOf(command)
      const metadata = metadataOf(command)
      if (existing === undefined) {
        return accepted([
          {
            _tag: "MessagePosted",
            id: command.messageId,
            author: command.author,
            body: command.body,
            ...origin,
            ...metadata
          }
        ])
      }
      // A post never changes a message that exists. It is a no-op when everything it says already holds, a
      // conflict otherwise: the run and notes it carries are compared as a patch that must change nothing.
      const before = metadataOf(existing)
      return existing.author === command.author && existing.body === command.body &&
          same(originOf(existing), origin) && same(before, { ...before, ...metadata })
        ? accepted([])
        : refused("message_conflict")
    }
    case "UpdateMessageStatus": {
      const existing = findMessage(chat, command.messageId)
      if (existing === undefined) return refused("message_missing")
      if (existing.status === command.status) return accepted([])
      if (isTerminal(existing.status)) return refused("terminal_status")
      return accepted([{ _tag: "MessageStatusUpdated", id: command.messageId, status: command.status }])
    }
    case "UpdateMessageMetadata": {
      const existing = findMessage(chat, command.messageId)
      if (existing === undefined) return refused("message_missing")
      const patch = metadataOf(command)
      const before = metadataOf(existing)
      const after = { ...before, ...patch }
      if (same(before, after)) return accepted([])
      if (isTerminal(existing.status) && !same(runOf(before), runOf(after))) return refused("terminal_metadata")
      // A write of the notes no newer than the one the message holds: delayed, and ignored whole.
      if (
        existing.noteVersion !== undefined && command.noteVersion !== undefined &&
        command.noteVersion <= existing.noteVersion
      ) return accepted([])
      return accepted([{ _tag: "MessageMetadataUpdated", id: command.messageId, ...patch }])
    }
    case "UpdateMessageBody": {
      const existing = findMessage(chat, command.messageId)
      if (existing === undefined) return refused("message_missing")
      // A question is never rewritten, by anyone; then only the message's own author extends it.
      if (existing.role === "user") return refused("body_question")
      if (existing.author !== command.author) return refused("body_author")
      // What the message already says, or said on the way here: a retry or a late update. Nothing to write.
      if (existing.body.startsWith(command.body)) return accepted([])
      if (isTerminal(existing.status)) return refused("terminal_body")
      if (!command.body.startsWith(existing.body)) return refused("body_conflict")
      return accepted([{ _tag: "MessageBodyUpdated", id: command.messageId, body: command.body }])
    }
  }
}

export const evolveChat = (chat: Chat, hubSeq: number, event: ChatEvent): Chat => {
  switch (event._tag) {
    case "MessagePosted":
      return {
        messages: [
          ...chat.messages,
          {
            id: event.id,
            author: event.author,
            body: event.body,
            status: "posted",
            hubSeq,
            ...originOf(event),
            ...metadataOf(event)
          }
        ]
      }
    case "MessageStatusUpdated":
      return {
        messages: chat.messages.map((message) =>
          message.id === event.id ? { ...message, status: event.status } : message
        )
      }
    case "MessageMetadataUpdated": {
      const patch = metadataOf(event)
      return {
        messages: chat.messages.map((message) => (message.id === event.id ? { ...message, ...patch } : message))
      }
    }
    case "MessageBodyUpdated":
      return {
        messages: chat.messages.map((message) => (message.id === event.id ? { ...message, body: event.body } : message))
      }
  }
}
