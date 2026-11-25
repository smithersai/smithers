/**
 * Chat messages: append-only, idempotent by message id, conflict-refusing.
 *
 * Mirrors `lean/smithers-state/SmithersState/Chat.lean`. A message records the
 * `hubSeq` of the commit that appended it; 0 means "optimistic, not yet committed".
 */
import * as Schema from "effect/Schema"
import { accepted, type Decision, refused } from "./Decision.ts"

export const MessageStatus = Schema.Literals(["posted", "streaming", "complete", "failed"])
export type MessageStatus = typeof MessageStatus.Type

export const Message = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
  status: MessageStatus,
  hubSeq: Schema.Int
})
export type Message = typeof Message.Type

export const Chat = Schema.Struct({ messages: Schema.Array(Message) })
export type Chat = typeof Chat.Type

export const emptyChat: Chat = { messages: [] }

export const PostMessage = Schema.TaggedStruct("PostMessage", {
  messageId: Schema.String,
  author: Schema.String,
  body: Schema.String
})
export const UpdateMessageStatus = Schema.TaggedStruct("UpdateMessageStatus", {
  messageId: Schema.String,
  status: MessageStatus
})
export const ChatCommand = Schema.Union([PostMessage, UpdateMessageStatus])
export type ChatCommand = typeof ChatCommand.Type

export const MessagePosted = Schema.TaggedStruct("MessagePosted", {
  id: Schema.String,
  author: Schema.String,
  body: Schema.String
})
export const MessageStatusUpdated = Schema.TaggedStruct("MessageStatusUpdated", {
  id: Schema.String,
  status: MessageStatus
})
export const ChatEvent = Schema.Union([MessagePosted, MessageStatusUpdated])
export type ChatEvent = typeof ChatEvent.Type

export type ChatRefusal = "message_conflict" | "message_missing" | "terminal_status"

export const findMessage = (chat: Chat, id: string): Message | undefined =>
  chat.messages.find((message) => message.id === id)

/** A terminal status is never overwritten by a later, stale update. */
export const isTerminal = (status: MessageStatus): boolean => status === "complete" || status === "failed"

export const decideChat = (chat: Chat, command: ChatCommand): Decision<ChatEvent, ChatRefusal> => {
  switch (command._tag) {
    case "PostMessage": {
      const existing = findMessage(chat, command.messageId)
      if (existing === undefined) {
        return accepted([{ _tag: "MessagePosted", id: command.messageId, author: command.author, body: command.body }])
      }
      return existing.author === command.author && existing.body === command.body
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
  }
}

export const evolveChat = (chat: Chat, hubSeq: number, event: ChatEvent): Chat => {
  switch (event._tag) {
    case "MessagePosted":
      return {
        messages: [
          ...chat.messages,
          { id: event.id, author: event.author, body: event.body, status: "posted", hubSeq }
        ]
      }
    case "MessageStatusUpdated":
      return {
        messages: chat.messages.map((message) =>
          message.id === event.id ? { ...message, status: event.status } : message
        )
      }
  }
}
