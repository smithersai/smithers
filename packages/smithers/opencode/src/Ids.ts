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
export const make = (kind: Kind, timestamp: number = Date.now()): string => {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter += 1
  return `${prefixes[kind]}_${head(timestamp, kind === "session", counter)}${randomTail(bodyLength - timeLength)}`
}

/**
 * A part id derived from its assistant message and a sort key, so the same
 * frame projected twice names the same part.
 *
 * The body keeps the message's time head, so parts of a later message sort
 * after parts of an earlier one, and appends the key, so parts of one message
 * sort by the key. The key is `frame`, `slot`, `ordinal`: the frame the part
 * belongs to, its place inside the frame, and its index among siblings.
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
  return `${prefixes.part}_${time}${encoded}${"0".repeat(bodyLength - timeLength - encoded.length)}`
}

/**
 * Whether a string carries the prefix of a kind.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isKind = (kind: Kind, id: string): boolean => id.startsWith(`${prefixes[kind]}_`)
