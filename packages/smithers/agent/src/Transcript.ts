/**
 * Transcripts of external agents: what a runner sends its host of the agent's
 * session as it happens, and how it makes each event safe and small first.
 *
 * A runner forwards the agent's `session/update` notifications (ACP), plus a
 * few of its own whose kinds start `_smithers/`, as numbered {@link Event}s:
 * `seq` counts from 0 within one job generation, so the host keeps each event
 * once however often the runner sends it, and answers the next `seq` it lacks
 * ({@link EventsResponse}), from which the runner sends again. The runner
 * keeps every event in a spool on its own disk until the host has it.
 *
 * Before an event leaves the runner, {@link prepare} drops the kinds that are
 * the agent's configuration rather than its work, replaces every secret value
 * and credential shape in its strings ({@link scrubber}), and bounds it to
 * {@link MAX_EVENT_BYTES}: long message text is split into several events,
 * and any other long string is cut. A message arrives as many chunks, so a
 * runner scrubs it with a {@link streamScrubber}, which holds back the end of
 * each chunk until the next shows whether a secret was being written across
 * the two. Nothing here names an agent vendor.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"

/**
 * The most bytes one event's `update`, as JSON, may hold.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_EVENT_BYTES = 16 * 1024

/**
 * The most bytes of events one request may carry, as JSON.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_BATCH_BYTES = 64 * 1024

/**
 * The most bytes of events a host keeps for one run. Past it the host keeps
 * one `_smithers/truncated` event and drops the rest.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_RUN_BYTES = 64 * 1024 * 1024

/**
 * The update kinds a runner never forwards: an agent's slash commands and
 * its configuration options describe its setup, not its work, and can be
 * tens of kilobytes each.
 *
 * @category constants
 * @since 1.0.0
 */
export const DROPPED_KINDS: ReadonlySet<string> = new Set(["available_commands_update", "config_option_update"])

/**
 * The kinds a runner adds of its own: a prompt turn ended (`{ stopReason }`),
 * the session ended (`{ outcome }`, the job's outcome code), a person's
 * message was handed to the agent (`{ id, mode }`, `mode` being `steering`,
 * `cancel_prompt` or `prompt`; never its words, which the host keeps), and a
 * stop the host asked for reached the agent (`{}`). Later slices add theirs
 * under the same prefix.
 *
 * @category constants
 * @since 1.0.0
 */
export const KINDS = {
  turn: "_smithers/turn",
  end: "_smithers/end",
  truncated: "_smithers/truncated",
  steer: "_smithers/steer",
  cancel: "_smithers/cancel"
} as const

/**
 * What a cut string ends with.
 *
 * @category constants
 * @since 1.0.0
 */
export const CUT = "…[cut]"

/**
 * What a scrubbed value becomes.
 *
 * @category constants
 * @since 1.0.0
 */
export const REDACTED = "[redacted]"

/**
 * The shapes scrubbed whatever a runner's profile says (OBS-5): API keys of
 * the `sk-` and `sess-` kinds, `Bearer` and `Basic` credentials, GitHub
 * tokens of every kind (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and
 * `github_pat_`), three-part JWTs, and email addresses (an agent can report
 * the account it is signed in as).
 *
 * @category constants
 * @since 1.0.0
 */
export const SHAPES: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bsess-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  // Anchored on the start of the local part's run, not on every word boundary in it: a long dotted string with
  // no `@` is then read once, not once from each of its dots.
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
]

/**
 * The most characters a {@link streamScrubber} holds back between two chunks
 * of one message: a secret value or credential longer than this, written
 * across chunks, is scrubbed only as far as each chunk shows it.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_HELD = 4096

/** The longest known values first, each at least 4 characters. */
const known = (secrets: Iterable<string>) =>
  [...new Set(secrets)].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)

const scrubValues = (text: string, values: ReadonlyArray<string>) => {
  let scrubbed = text
  for (const value of values) scrubbed = scrubbed.split(value).join(REDACTED)
  return scrubbed
}

const scrubShapes = (text: string) => {
  let scrubbed = text
  for (const shape of SHAPES) scrubbed = scrubbed.replace(shape, REDACTED)
  return scrubbed
}

/** Whether a UTF-16 unit can be part of a credential shape: a word character or one of `.~+/=%@-`. */
const credentialUnit = (unit: number) =>
  (unit >= 48 && unit <= 57) || (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) || unit === 95 ||
  unit === 46 || unit === 126 || unit === 43 || unit === 47 || unit === 61 || unit === 37 || unit === 64 || unit === 45

const SCHEME = /\b(?:Bearer|Basic)\s+$/

/**
 * Where a secret still being written could begin at the end of `text`: the
 * start of its last run of credential characters, of the `Bearer` or `Basic`
 * before that run, or of the longest ending that begins one of `values`,
 * whichever is first. At most {@link MAX_HELD} characters from the end, and
 * `text.length` when nothing is open.
 */
const openFrom = (text: string, values: ReadonlyArray<string>) => {
  const floor = Math.max(0, text.length - MAX_HELD)
  let start = text.length
  while (start > floor && credentialUnit(text.charCodeAt(start - 1))) start--
  const scheme = SCHEME.exec(text.slice(Math.max(floor, start - 16), start))
  if (scheme !== null) start -= scheme[0].length
  for (const value of values) {
    for (let length = Math.min(value.length - 1, text.length - floor); length > text.length - start; length--) {
      if (text.endsWith(value.slice(0, length))) {
        start = text.length - length
        break
      }
    }
  }
  return start
}

/**
 * A scrubber over `secrets`, the values known to be secret: each value of at
 * least 4 characters, longest first, then every {@link SHAPES} match, becomes
 * {@link REDACTED}. With no secrets it scrubs the shapes only, as a host does.
 *
 * @category constructors
 * @since 1.0.0
 */
export const scrubber = (secrets: Iterable<string> = []): Scrubber => {
  const values = known(secrets)
  return Object.assign((text: string) => scrubShapes(scrubValues(text, values)), {
    closed: (text: string) => text.slice(0, openFrom(text, values))
  })
}

/**
 * What {@link scrubber} makes: called as a function it scrubs one whole
 * string.
 *
 * @category models
 * @since 1.0.0
 */
export interface Scrubber {
  (text: string): string
  /**
   * `text` without an ending a secret could still be open in (its last run
   * of credential characters, or the beginning of a secret value): what a
   * string cut at its end may keep.
   */
  readonly closed: (text: string) => string
}

/**
 * The message a text chunk belongs to, as a {@link StreamScrubber} keeps it:
 * `key` tells one message from the next, and `kind` and `update` (the chunk
 * with its text empty) are what a held ending is sent in.
 *
 * @category models
 * @since 1.0.0
 */
export interface StreamMessage {
  readonly key: string
  readonly kind: string
  readonly update: Readonly<Record<string, unknown>>
}

/**
 * A scrubber for one session's updates in order ({@link streamScrubber}).
 * Called as a function it scrubs one whole string, as {@link scrubber} does.
 *
 * @category models
 * @since 1.0.0
 */
export interface StreamScrubber extends Scrubber {
  /**
   * Takes the next chunk of `message` and answers the text that may leave
   * now, each with the message it belongs to: first what was held of an
   * earlier message, then this one's text up to where a secret could still
   * be open. Empty text is left out.
   */
  readonly take: (message: StreamMessage, text: string) => ReadonlyArray<readonly [StreamMessage, string]>
  /** Ends the message in flight: what was held of it, scrubbed, if anything. */
  readonly end: () => ReadonlyArray<readonly [StreamMessage, string]>
}

/**
 * A scrubber over `secrets` for one session, which also scrubs a secret
 * written across the chunks of a message. {@link prepare} given it holds back
 * the end of each text chunk (at most {@link MAX_HELD} characters: the last
 * run of credential characters, or the beginning of a secret value) until
 * the next chunk of the same message completes or clears it, and sends what
 * it still holds, as one more chunk of that message, before the first update
 * that is not one. Make one for each session: it remembers the message in
 * flight.
 *
 * @example
 * ```ts
 * import { Transcript } from "@smthrs/agent"
 *
 * const scrub = Transcript.streamScrubber(["hunter2-token"])
 * const chunk = (text: string) =>
 *   Transcript.prepare("agent_message_chunk", { messageId: "m1", content: { type: "text", text } }, scrub)
 * // The value is split across two chunks; neither half leaves.
 * const sent = [...chunk("key hunter2-"), ...chunk("token "), ...Transcript.prepare("_smithers/turn", {}, scrub)]
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export const streamScrubber = (secrets: Iterable<string> = []): StreamScrubber => {
  const values = known(secrets)
  let message: StreamMessage | undefined
  let held = ""
  // Set while a credential longer than `MAX_HELD` is being written: its start left as `REDACTED`, so the rest of
  // its run is dropped, not sent as text no shape matches.
  let swallowing = false
  const end = (): ReadonlyArray<readonly [StreamMessage, string]> => {
    const ended = message
    const text = scrubShapes(held)
    message = undefined
    held = ""
    swallowing = false
    return ended === undefined || text === "" ? [] : [[ended, text]]
  }
  const take = (next: StreamMessage, chunk: string) => {
    const before = message !== undefined && message.key !== next.key ? end() : []
    message = next
    let text = chunk
    if (swallowing) {
      let run = 0
      while (run < text.length && credentialUnit(text.charCodeAt(run))) run++
      text = text.slice(run)
      swallowing = text === ""
    }
    const joined = scrubValues(held + text, values)
    const start = openFrom(joined, values)
    const head = joined.slice(0, start)
    const sent = scrubShapes(head)
    held = joined.slice(start)
    // The held run is as long as may be held and still open at its start: a shape that reached the end of what
    // was sent goes on into it.
    if (held.length === MAX_HELD && credentialUnit(joined.charCodeAt(start - 1)) && sent.endsWith(REDACTED)) {
      held = ""
      swallowing = true
    }
    return sent === "" ? before : [...before, [next, sent] as const]
  }
  return Object.assign(scrubber(values), { take, end })
}

/**
 * An update's fields: any JSON object.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Update = Schema.Record(Schema.String, Schema.Unknown)

/**
 * One event as a runner sends it: its number within the job's generation,
 * when the runner received it (epoch milliseconds), its kind (the update's
 * `sessionUpdate`, or a {@link KINDS} value), and the update.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Event = Schema.Struct({
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  kind: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_/.-]{1,64}$/)),
  update: Update
})

/**
 * One event as a runner sends it, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Event = typeof Event.Type

/**
 * A runner's events of one job, fenced to the runner that holds or held its
 * claim. An empty `events` asks only where the host stands.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventsRequest = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  claim: Schema.String.check(Schema.isMinLength(1)),
  events: Schema.Array(Event)
})

/**
 * The lowest `seq` of the job's generation the host doesn't have yet: the
 * runner drops every event below it and sends again from it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventsResponse = Schema.Struct({ next: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })

/** Each string in `value`, at any depth, through `map`. */
const mapStrings = (value: unknown, map: (text: string) => string): unknown => {
  if (typeof value === "string") return map(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]))
  }
  return value
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

/**
 * Where to end a piece of `text` meant to end at `end`: one unit earlier when
 * `end` would part a surrogate pair, so no piece ends with a lone high
 * surrogate or begins with a lone low one. The callers' `size` is at least
 * two, so a piece always moves on.
 */
const boundary = (text: string, end: number) => {
  if (end >= text.length) return text.length
  const unit = text.charCodeAt(end - 1)
  return unit >= 0xd800 && unit <= 0xdbff ? end - 1 : end
}

/** `text` split into pieces of at most `size` characters, none parting a surrogate pair. */
const pieces = (text: string, size: number) => {
  const out: Array<string> = []
  for (let at = 0; at < text.length;) {
    const end = boundary(text, at + size)
    out.push(text.slice(at, end))
    at = end
  }
  return out
}

/** `update` with every string longer than `size` characters cut to it, never through a surrogate pair. */
const cut = (update: Record<string, unknown>, size: number) =>
  mapStrings(
    update,
    (text) => text.length > size ? text.slice(0, boundary(text, size)) + CUT : text
  ) as Record<string, unknown>

/** The events of one scrubbed update: itself when it fits, else its message split or its long strings cut. */
const bounded = (
  kind: string,
  clean: Record<string, unknown>
): ReadonlyArray<{ readonly kind: string; readonly update: Record<string, unknown> }> => {
  if (bytes(clean) <= MAX_EVENT_BYTES) return [{ kind, update: clean }]
  const content = clean.content as { readonly type?: unknown; readonly text?: unknown } | undefined
  if (content?.type === "text" && typeof content.text === "string") {
    // A character is at most 6 bytes as JSON (`\uXXXX`); the rest of the update is small.
    const rest = bytes({ ...clean, content: { ...content, text: "" } })
    if (rest < MAX_EVENT_BYTES / 2) {
      return pieces(content.text, Math.floor((MAX_EVENT_BYTES - rest) / 6)).map((text) => ({
        kind,
        update: { ...clean, content: { ...content, text } }
      }))
    }
  }
  let size = 4096
  let bound = cut(clean, size)
  while (bytes(bound) > MAX_EVENT_BYTES && size > 16) {
    size = Math.floor(size / 2)
    bound = cut(clean, size)
  }
  return bytes(bound) <= MAX_EVENT_BYTES ? [{ kind, update: bound }] : [{ kind, update: { cut: true } }]
}

const isStream = (scrub: (text: string) => string): scrub is StreamScrubber => "take" in scrub

/** A cut string's ending a credential shape could be open in, for a scrubber that can't say for its own values. */
const closedShapes = scrubber().closed

/** The text of an update that is a chunk of a message, with the update around it. */
const textChunk = (update: Readonly<Record<string, unknown>>) => {
  const content = update.content
  if (content === null || typeof content !== "object") return undefined
  const { text, type } = content as { readonly type?: unknown; readonly text?: unknown }
  return type === "text" && typeof text === "string" ? { content: content as Record<string, unknown>, text } : undefined
}

/**
 * One update made ready to leave the runner: none for a {@link DROPPED_KINDS}
 * kind; otherwise the update with every string scrubbed by `scrub`, as one or
 * more events' `{ kind, update }` each at most {@link MAX_EVENT_BYTES} as JSON.
 * A message chunk (a `content` of type `text`) too long for one event becomes
 * several chunks of the same message; any other update too long has its long
 * strings cut, ending {@link CUT}. A string other than a message's text that
 * is longer than {@link MAX_EVENT_BYTES} characters is cut to that before it
 * is scrubbed, so scrubbing reads a bounded string.
 *
 * Given a {@link StreamScrubber}, a message chunk's ending that a secret could
 * still be open in is held for the next call: a chunk can then answer no
 * event, and the first update that is not a chunk of the same message is
 * preceded by one more chunk of it, carrying what was held.
 *
 * @category constructors
 * @since 1.0.0
 */
export const prepare = (
  kind: string,
  update: Readonly<Record<string, unknown>>,
  scrub: ((text: string) => string) | Scrubber | StreamScrubber
): ReadonlyArray<{ readonly kind: string; readonly update: Record<string, unknown> }> => {
  if (DROPPED_KINDS.has(kind)) return []
  const closed = "closed" in scrub ? scrub.closed : closedShapes
  // Bounded before it is scrubbed. The cut drops an ending a secret could be open in, so no part of one is left
  // where the scrubber would not know it.
  const short = (text: string) =>
    text.length <= MAX_EVENT_BYTES ? scrub(text) : scrub(closed(text.slice(0, boundary(text, MAX_EVENT_BYTES)))) + CUT
  const chunk = textChunk(update)
  if (chunk === undefined) {
    const ended = isStream(scrub) ? scrub.end() : []
    return [
      ...ended.flatMap(([message, text]) => bounded(message.kind, withText(message.update, text))),
      ...bounded(kind, mapStrings(update, short) as Record<string, unknown>)
    ]
  }
  const around = mapStrings({ ...update, content: { ...chunk.content, text: "" } }, short) as Record<string, unknown>
  if (!isStream(scrub)) return bounded(kind, withText(around, scrub(chunk.text)))
  const key = `${kind}\u0000${typeof update.messageId === "string" ? update.messageId : ""}`
  return scrub.take({ key, kind, update: around }, chunk.text).flatMap(([message, text]) =>
    bounded(message.kind, withText(message.update, text))
  )
}

/** `update`, a text chunk, with `text` as its text. */
const withText = (update: Readonly<Record<string, unknown>>, text: string): Record<string, unknown> => ({
  ...update,
  content: { ...update.content as Record<string, unknown>, text }
})
