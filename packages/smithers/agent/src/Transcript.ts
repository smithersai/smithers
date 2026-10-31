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
 * and any other long string is cut. Nothing here names an agent vendor.
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
 * and the session ended (`{ outcome }`, the job's outcome code). Later
 * slices add theirs under the same prefix.
 *
 * @category constants
 * @since 1.0.0
 */
export const KINDS = {
  turn: "_smithers/turn",
  end: "_smithers/end",
  truncated: "_smithers/truncated"
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
 * the `sk-` and `sess-` kinds, bearer credentials, GitHub tokens, three-part
 * JWTs, and email addresses (an agent can report the account it is signed in
 * as).
 *
 * @category constants
 * @since 1.0.0
 */
export const SHAPES: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bsess-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\bghp_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
]

/**
 * A scrubber over `secrets`, the values known to be secret: each value of at
 * least 4 characters, longest first, then every {@link SHAPES} match, becomes
 * {@link REDACTED}. With no secrets it scrubs the shapes only, as a host does.
 *
 * @category constructors
 * @since 1.0.0
 */
export const scrubber = (secrets: Iterable<string> = []) => {
  const values = [...new Set(secrets)].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)
  return (text: string): string => {
    let scrubbed = text
    for (const value of values) scrubbed = scrubbed.split(value).join(REDACTED)
    for (const shape of SHAPES) scrubbed = scrubbed.replace(shape, REDACTED)
    return scrubbed
  }
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

/** `text` split into pieces of at most `size` characters. */
const pieces = (text: string, size: number) => {
  const out: Array<string> = []
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size))
  return out
}

/** `update` with every string longer than `size` characters cut to it. */
const cut = (update: Record<string, unknown>, size: number) =>
  mapStrings(update, (text) => text.length > size ? text.slice(0, size) + CUT : text) as Record<string, unknown>

/**
 * One update made ready to leave the runner: none for a {@link DROPPED_KINDS}
 * kind; otherwise the update with every string scrubbed by `scrub`, as one or
 * more events' `{ kind, update }` each at most {@link MAX_EVENT_BYTES} as JSON.
 * A message chunk (a `content` of type `text`) too long for one event becomes
 * several chunks of the same message; any other update too long has its long
 * strings cut, ending {@link CUT}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const prepare = (
  kind: string,
  update: Readonly<Record<string, unknown>>,
  scrub: (text: string) => string
): ReadonlyArray<{ readonly kind: string; readonly update: Record<string, unknown> }> => {
  if (DROPPED_KINDS.has(kind)) return []
  const clean = mapStrings(update, scrub) as Record<string, unknown>
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
  let bounded = cut(clean, size)
  while (bytes(bounded) > MAX_EVENT_BYTES && size > 16) {
    size = Math.floor(size / 2)
    bounded = cut(clean, size)
  }
  return bytes(bounded) <= MAX_EVENT_BYTES ? [{ kind, update: bounded }] : [{ kind, update: { cut: true } }]
}
