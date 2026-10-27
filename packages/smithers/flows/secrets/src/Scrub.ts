/**
 * Scrubbing: replace a secret's value, wherever an answer echoes it, with its
 * placeholder before the guest sees the answer.
 *
 * A host that received a value may send it back: an API that lists the
 * caller's tokens, an echo service, an error that quotes the request. The
 * scrubber looks for each value in the forms such an echo takes
 * ({@link forms}):
 *
 * - the value itself, as UTF-8;
 * - percent-encoded, with uppercase and lowercase hexadecimal, and with `+`
 *   for a space;
 * - inside a JSON string;
 * - inside base64 or base64url, at each of the three byte alignments, so the
 *   value is found inside a longer encoded string such as a Basic
 *   credential's `user:value`.
 *
 * {@link Scrubber.stream} scrubs a body as it streams. It holds back fewer
 * bytes than the longest form, so a value split across chunks is still
 * found, and it adds no other delay or bound on the body's size. A
 * transformation outside these forms, such as hexadecimal or a hash, is not
 * found: bind a secret only to hosts whose answers have been reviewed.
 *
 * @since 0.1.0
 */

import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import { base64, concat, text, utf8 } from "./internal/bytes.ts"

/**
 * A value to scrub, and the text that replaces it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Target {
  readonly value: Redacted.Redacted<string>
  readonly replacement: string
}

/**
 * Scrubs every {@link Target} it was made with.
 *
 * @category models
 * @since 0.1.0
 */
export interface Scrubber {
  /** Whether there is anything to scrub. A scrubber made with no targets changes nothing. */
  readonly active: boolean
  /** `value` with every form of every target replaced. */
  readonly text: (value: string) => string
  /** `body` with every form of every target replaced, as it streams. */
  readonly stream: <E, R>(body: Stream.Stream<Uint8Array, E, R>) => Stream.Stream<Uint8Array, E, R>
}

/**
 * The forms of `value` an echo may take, without repeats. A base64 form is
 * the run of characters that depend only on the value's bytes at that
 * alignment, so it is found wherever the value sits in an encoded string.
 *
 * @category scrubbing
 * @since 0.1.0
 */
export const forms = (value: string): ReadonlyArray<string> => {
  const percent = encodeURIComponent(value)
  const found = new Set([
    value,
    percent,
    percent.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    percent.replace(/%20/g, "+"),
    JSON.stringify(value).slice(1, -1)
  ])
  const bytes = utf8(value)
  for (let alignment = 0; alignment < 3; alignment++) {
    const shifted = concat([new Uint8Array(alignment), bytes])
    const from = Math.ceil((8 * alignment) / 6)
    const to = Math.floor((8 * shifted.length) / 6)
    for (const alphabet of ["standard", "url"] as const) {
      found.add(base64(shifted, alphabet, false).slice(from, to))
    }
  }
  found.delete("")
  return [...found]
}

interface Pattern {
  readonly bytes: Uint8Array
  readonly replacement: Uint8Array
  readonly tokens?: ReadonlyArray<ReadonlyArray<Uint8Array>>
}

const matchesAt = (input: Uint8Array, at: number, pattern: Uint8Array): boolean => {
  for (let index = 0; index < pattern.length; index++) {
    if (input[at + index] !== pattern[index]) return false
  }
  return true
}

// Alternatives are per byte, rather than a Cartesian product of whole echoes.
// Every token is nonempty and prefix-free, so matching needs no backtracking.
const percentTokens = (value: string): ReadonlyArray<ReadonlyArray<Uint8Array>> =>
  Array.from(utf8(value), (byte) => {
    const hex = byte.toString(16).padStart(2, "0")
    const escapes = [...new Set([hex.charAt(0), hex.charAt(0).toUpperCase()])].flatMap((first) =>
      [...new Set([hex.charAt(1), hex.charAt(1).toUpperCase()])].map((last) => utf8(`%${first}${last}`))
    )
    if (byte === 32) escapes.push(utf8("+"))
    if (/^[A-Za-z0-9!'()*~._-]$/.test(String.fromCharCode(byte))) escapes.push(Uint8Array.of(byte))
    return escapes
  })

const hexCases = (hex: string): ReadonlyArray<string> => {
  let variants = [""]
  for (const digit of hex) {
    variants = variants.flatMap((prefix) => [...new Set([digit, digit.toUpperCase()])].map((next) => prefix + next))
  }
  return variants
}

// JSON permits a Unicode escape for every UTF-16 unit, including ASCII.
// Astral literals and escaped surrogate pairs are alternatives of one token.
const jsonTokens = (value: string): ReadonlyArray<ReadonlyArray<Uint8Array>> =>
  Array.from(value, (point) => {
    let escaped = [""]
    for (const unit of point.split("")) {
      const variants = hexCases(unit.charCodeAt(0).toString(16).padStart(4, "0"))
      escaped = escaped.flatMap((prefix) => variants.map((hex) => `${prefix}\\u${hex}`))
    }
    const alternatives = new Set([JSON.stringify(point).slice(1, -1), ...escaped])
    if (point === "/") alternatives.add("\\/")
    return [...alternatives].map(utf8)
  })

const matchedLength = (input: Uint8Array, at: number, pattern: Pattern): number => {
  if (pattern.tokens === undefined) {
    return pattern.bytes.length <= input.length - at && matchesAt(input, at, pattern.bytes) ? pattern.bytes.length : 0
  }
  let end = at
  for (const token of pattern.tokens) {
    const hit = token.find((bytes) => bytes.length <= input.length - end && matchesAt(input, end, bytes))
    if (hit === undefined) return 0
    end += hit.length
  }
  return end - at
}

/**
 * A scrubber for `targets`. Where two forms match at one position, the
 * longer one is replaced.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (targets: ReadonlyArray<Target>): Scrubber => {
  const patterns: Array<Pattern> = []
  for (const target of targets) {
    const replacement = utf8(target.replacement)
    const value = Redacted.value(target.value)
    for (const form of forms(value)) patterns.push({ bytes: utf8(form), replacement })
    if (value.length > 0) {
      for (const tokens of [percentTokens(value), jsonTokens(value)]) {
        const longestTokens = tokens.map((token) =>
          token.reduce((longest, next) => next.length > longest.length ? next : longest)
        )
        patterns.push({ bytes: concat(longestTokens), tokens, replacement })
      }
    }
  }
  patterns.sort((left, right) => right.bytes.length - left.bytes.length)
  const longest = patterns[0]?.bytes.length ?? 0
  const firsts = new Set(
    patterns.flatMap((pattern) => pattern.tokens?.[0]!.map((bytes) => bytes[0]) ?? [pattern.bytes[0]])
  )

  /**
   * Scrubs `input` up to where a form could still continue in the next chunk, or to its end when `final`, and
   * answers the scrubbed bytes and the bytes held back.
   */
  const scan = (input: Uint8Array, final: boolean) => {
    const limit = final ? input.length : input.length - longest + 1
    const parts: Array<Uint8Array> = []
    let start = 0
    let at = 0
    while (at < limit) {
      if (firsts.has(input[at])) {
        let length = 0
        let replacement: Uint8Array | undefined
        for (const pattern of patterns) {
          const matched = matchedLength(input, at, pattern)
          if (matched > length) {
            length = matched
            replacement = pattern.replacement
          }
        }
        if (replacement !== undefined) {
          parts.push(input.subarray(start, at), replacement)
          at += length
          start = at
          continue
        }
      }
      at++
    }
    parts.push(input.subarray(start, at))
    return { done: concat(parts), held: input.slice(at) }
  }

  const emit = (bytes: Uint8Array): ReadonlyArray<Uint8Array> => (bytes.length > 0 ? [bytes] : [])

  return {
    active: patterns.length > 0,
    text: (value) => (patterns.length > 0 ? text(scan(utf8(value), true).done) : value),
    stream: (body) =>
      patterns.length === 0 ? body : body.pipe(
        Stream.mapAccum(
          () => new Uint8Array(0),
          (held: Uint8Array, chunk: Uint8Array) => {
            const { done, held: next } = scan(concat([held, chunk]), false)
            return [next, emit(done)] as const
          },
          { onHalt: (held) => emit(scan(held, true).done) }
        )
      )
  }
}
