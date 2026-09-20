/**
 * OpenCode identifiers: a prefix, a time-ordered head, and a random tail.
 *
 * The hosted app keeps sessions, messages, and parts in arrays sorted by id
 * and inserts with a binary search, so an id has to sort in creation order or
 * a later part lands above an earlier one. OpenCode encodes a millisecond
 * timestamp and a per-millisecond counter into twelve hex characters, and
 * sorts sessions the other way round (newest first) by inverting the bits.
 * This module produces the same shape so the app and every OpenAPI pattern
 * (`^ses`, `^msg`, `^prt`, `^per`, `^evt_`) accept it.
 *
 * Parts are the exception: their id is derived from the assistant message
 * and a sort key rather than drawn fresh, so a replayed frame that emits the
 * same call again names the same part and the app updates it instead of
 * rendering a second card.
 *
 * @since 1.0.0
 */
import { webcrypto } from "node:crypto"

/**
 * The id kinds the server mints, with OpenCode's prefixes.
 *
 * @category constants
 * @since 1.0.0
 */
export const prefixes = {
  session: "ses",
  message: "msg",
  part: "prt",
  permission: "per",
  event: "evt"
} as const

/**
 * A kind of id.
 *
 * @category models
 * @since 1.0.0
 */
export type Kind = keyof typeof prefixes

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const bodyLength = 26
const timeLength = 12

let lastTimestamp = 0
let counter = 0

/**
 * The twelve-character time head of an id body: `timestamp * 4096 + counter`,
 * inverted for a descending kind, as OpenCode writes it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const head = (timestamp: number, descending: boolean, sequence: number): string => {
  const current = BigInt(timestamp) * 0x1000n + BigInt(sequence)
  const value = descending ? ~current : current
  let text = ""
  for (let index = 0; index < 6; index++) {
    text += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0")
  }
  return text
}

const randomTail = (length: number): string => {
  const bytes = webcrypto.getRandomValues(new Uint8Array(length))
  let text = ""
  for (const byte of bytes) text += alphabet[byte % alphabet.length]
  return text
}

/**
 * Mints a fresh id. Sessions sort newest first; everything else sorts in
 * creation order, including two ids minted in the same millisecond.
 *
 * @param kind which prefix and direction
 * @param timestamp the creation time; defaults to now
 * @category constructors
 * @since 1.0.0
 */
export const make = (kind: Kind, timestamp: number = Date.now()): string =>
  `${prefixes[kind]}_${head(timestamp, kind === "session", sequence(timestamp))}${randomTail(bodyLength - timeLength)}`

/** The next counter for a millisecond, restarted whenever the millisecond changes. */
const sequence = (timestamp: number): number => {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter += 1
  return counter
}

/**
 * A part id derived from its assistant message and a sort key, so the same
 * frame projected twice names the same part.
 *
 * The body keeps the message's time head, so parts of a later message sort
 * after parts of an earlier one, appends the key, so parts of one message
 * sort by the key, and ends with the last four characters of the message's
 * tail, so two messages that share a head (a prompt and the answer derived
 * from it by {@link reply}) still name distinct parts. The key is `frame`,
 * `slot`, `ordinal`: the frame the part belongs to, its place inside the
 * frame, and its index among siblings.
 *
 * @param messageID the assistant message the part belongs to
 * @param key where the part sits in the message
 * @category constructors
 * @since 1.0.0
 */
export const part = (
  messageID: string,
  key: { readonly frame: number; readonly slot: number; readonly ordinal: number }
): string => {
  const body = messageID.slice(messageID.indexOf("_") + 1)
  const time = body.slice(0, timeLength).padEnd(timeLength, "0")
  const encoded = key.frame.toString(16).padStart(4, "0") +
    key.slot.toString(16).padStart(2, "0") +
    key.ordinal.toString(16).padStart(4, "0")
  const tail = body.slice(timeLength).slice(-(bodyLength - timeLength - encoded.length))
  return `${prefixes.part}_${time}${encoded}${tail.padStart(bodyLength - timeLength - encoded.length, "0")}`
}

/**
 * The id of the assistant message that answers a user message, derived so
 * a prompt the app retries with the same message id runs the same
 * execution: the user id's tail plus one, which sorts right after it and
 * before the next message. A tail with nothing left to add falls back to a
 * fresh id.
 *
 * @param userMessageID the user message the answer replies to
 * @category constructors
 * @since 1.0.0
 */
export const reply = (userMessageID: string): string => {
  const chars = userMessageID.slice(userMessageID.indexOf("_") + 1).split("")
  for (let index = chars.length - 1; index >= timeLength; index--) {
    const at = alphabet.indexOf(chars[index]!)
    if (at < alphabet.length - 1) {
      chars[index] = alphabet[at + 1]!
      return `${prefixes.message}_${chars.join("")}`
    }
    chars[index] = alphabet[0]!
  }
  return make("message")
}

/**
 * The id of a prompt steered into a turn that is already running, derived so
 * it sorts after that turn's own prompt and before the answer it is steered
 * into.
 *
 * A fresh id would sort after the answer, because the answer was minted when
 * the turn opened and this prompt is arriving now. The hosted app keeps
 * messages in id order, so the person's words would land below the answer
 * they are still shaping, and a user message with nothing after it is a
 * question the app reads as unanswered.
 *
 * There is no room between the two ids at their own length: the answer is
 * {@link reply} of the prompt, which is the prompt's id with its tail nudged
 * up by one. So the id is the prompt's own body with a time head appended,
 * which sorts after the prompt (a string is above every prefix of itself) and
 * below the answer (they first differ where the answer was nudged up), and
 * two steers of one turn sort in the order they were sent.
 *
 * The answer of a prompt whose tail had nothing left to nudge is a fresh id
 * instead, and nothing can be derived to sit before it; that is what the
 * comparison guards, and it falls back to a fresh id of its own.
 *
 * @param userMessageID the prompt that opened the running turn
 * @param assistantMessageID the answer the steer is folded into
 * @param timestamp the creation time; defaults to now
 * @category constructors
 * @since 1.0.0
 */
export const steer = (
  userMessageID: string,
  assistantMessageID: string,
  timestamp: number = Date.now()
): string => {
  const body = userMessageID.slice(userMessageID.indexOf("_") + 1)
  const candidate = `${prefixes.message}_${body}${head(timestamp, false, sequence(timestamp))}`
  return candidate < assistantMessageID ? candidate : make("message", timestamp)
}

/**
 * Whether a string carries the prefix of a kind.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isKind = (kind: Kind, id: string): boolean => id.startsWith(`${prefixes[kind]}_`)
