/**
 * Schemas for the Bot API message a Telegram event carries as its payload.
 *
 * Core fields are typed and everything else passes through, so a flow can
 * read a Bot API field this package does not model.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const

const open = <Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.StructWithRest(Schema.Struct(fields), rest)

/**
 * A chat.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Chat = open({
  id: Schema.Number,
  type: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String)
})

/**
 * A user.
 *
 * @category schemas
 * @since 1.0.0
 */
export const User = open({
  id: Schema.Number,
  is_bot: Schema.optional(Schema.Boolean),
  first_name: Schema.optional(Schema.String),
  last_name: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String)
})

/**
 * A message, the payload of `integration:telegram:message` and
 * `integration:telegram:edited_message`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Message = open({
  message_id: Schema.Number,
  date: Schema.Number,
  chat: Chat,
  from: Schema.optional(User),
  text: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  message_thread_id: Schema.optional(Schema.Number),
  reply_to_message: Schema.optional(open({ message_id: Schema.Number }))
})

/**
 * A decoded message.
 *
 * @category models
 * @since 1.0.0
 */
export type Message = typeof Message.Type
