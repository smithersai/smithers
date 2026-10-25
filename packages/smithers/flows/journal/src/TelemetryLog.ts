/**
 * The `telemetry.log` journal record: its durable schema and the bounded,
 * redacted snapshot of an Effect log event that fills it.
 *
 * A log record is written to a run's journal on the lossy channel by two
 * producers: `@smthrs/observability`'s `JournalLogger`, which forwards a whole
 * process's logs to one run, and `@smthrs/engine-store`, which journals what an
 * action attempt's body logs to the attempt's own run. Both build the payload
 * here, so there is one schema and one snapshot. The module depends on nothing
 * but Effect and this package's redaction rules, so it loads in a browser, a
 * Worker, Node and Bun.
 *
 * The snapshot runs inside a logger callback: synchronously, on someone else's
 * fiber, with an arbitrary logged value. It is therefore total (it never
 * throws), detached (it copies the value before any asynchronous delivery, and
 * never runs a caller's getter, `toJSON` or `toISOString`), bounded (in bytes,
 * container members and depth, measured in one forward pass), and redacted
 * before it returns.
 *
 * @since 1.0.0
 */

import type * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import type * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import * as Redaction from "./Redaction.ts"

/**
 * The journal event type every log record is written under.
 *
 * @category constants
 * @since 1.0.0
 */
export const eventType = "telemetry.log"

/**
 * Largest encoded payload a snapshot produces, and the default bound.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumSnapshotBytes = 1024 * 1024

/**
 * Largest number of container members copied into one snapshot.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumSnapshotMembers = 4_096

/**
 * Deepest container path copied into one snapshot.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumSnapshotDepth = 64

/**
 * What a hostile or unreadable logged value becomes.
 *
 * @category constants
 * @since 1.0.0
 */
export const unrenderableMarker = "[Unrenderable]"

/**
 * What a value beyond a snapshot ceiling becomes.
 *
 * @category constants
 * @since 1.0.0
 */
export const truncatedMarker = "[Truncated]"

/**
 * What an Effect `Redacted` value becomes: the wrapper's own rendering without
 * its label, and never the value it hides.
 *
 * @category constants
 * @since 1.0.0
 */
export const redactedMarker = "<redacted>"

/**
 * One typed failure retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Fail = Schema.Struct({
  _tag: Schema.Literal("Fail"),
  error: Schema.Unknown
})

/**
 * One unexpected defect retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Die = Schema.Struct({
  _tag: Schema.Literal("Die"),
  defect: Schema.Unknown
})

/**
 * One interruption retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Interrupt = Schema.Struct({
  _tag: Schema.Literal("Interrupt"),
  fiberId: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

/**
 * One reason in a persisted log cause.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CauseReason = Schema.Union([Fail, Die, Interrupt])

/**
 * One reason in a persisted log cause.
 *
 * @category models
 * @since 1.0.0
 */
export type CauseReason = typeof CauseReason.Type

/**
 * A versioned structural Effect cause.
 *
 * Effect 4 stores composed failures as an ordered reason list. The projection
 * preserves that order and each fail, defect, or interrupt discriminator.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LogCause = Schema.Struct({
  version: Schema.Literal(1),
  reasons: Schema.Array(CauseReason)
})

/**
 * A versioned structural Effect cause.
 *
 * @category models
 * @since 1.0.0
 */
export type LogCause = typeof LogCause.Type

/**
 * Runtime schema for the log record payload written to the journal.
 *
 * `message` is what the logger was handed: Effect passes one array entry per
 * argument. `annotations` are the fiber's log annotations at the moment of the
 * call, and `timestamp` is that moment as ISO-8601 UTC.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Log = Schema.Struct({
  version: Schema.Literal(1),
  level: Schema.Literals(["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]),
  message: Schema.Unknown,
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  cause: LogCause,
  fiberId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String),
  timestamp: Schema.String
})

/**
 * Versioned log record payload written to the journal.
 *
 * @category models
 * @since 1.0.0
 */
export type Log = typeof Log.Type

/**
 * How one {@link snapshot} is bounded, attributed and redacted.
 *
 * @category models
 * @since 1.0.0
 */
export interface SnapshotOptions {
  /**
   * Largest encoded payload, in UTF-8 bytes of its JSON, capped at
   * {@link maximumSnapshotBytes}; a value that is not finite takes that cap.
   * Given, the record's envelope is reserved first, so the message, annotations
   * and cause share what remains and a long message is cut. Omitted, the values
   * share {@link maximumSnapshotBytes} and a record whose envelope pushes it
   * over degrades. A record that cannot fit either way keeps its level, time
   * and {@link SnapshotOptions.annotations} and loses its message.
   */
  readonly maximumBytes?: number | undefined
  /**
   * Annotations copied ahead of the fiber's, winning over a fiber annotation
   * of the same name and kept by every fallback record. For attribution the
   * producer controls, such as run and step ids; never a value.
   */
  readonly annotations?: Readonly<Record<string, unknown>> | undefined
  /**
   * The redaction rules. Defaults to `Redaction.defaultRules`, the journal's
   * write rules; a diagnostic producer passes `Redaction.diagnosticRules`.
   */
  readonly rules?: ReadonlyArray<Redaction.Rule> | undefined
}

const encoder = new TextEncoder()

interface SnapshotBudget {
  bytes: number
  members: number
  /** The configured ceiling: no text longer than this many units is measured whole. */
  readonly limit: number
}

const reserve = (budget: SnapshotBudget, bytes: number): boolean => {
  if (bytes > budget.bytes) return false
  budget.bytes -= bytes
  return true
}

const textBytes = (value: string): number => encoder.encode(JSON.stringify(value)).byteLength

const shortEscapes = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

/** Bytes one non-surrogate code unit occupies inside a JSON string body. */
const unitBytes = (code: number): number => {
  if (code === 0x22 || code === 0x5c) return 2
  if (code < 0x20) return shortEscapes.has(code) ? 2 : 6
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  return 3
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** Code units that occupy exactly one byte inside a JSON string body. */
const plainRun = /[\x20\x21\x23-\x5b\x5d-\x7f]*/y

/** One-byte units read one at a time before the rest of their run is matched natively. */
const plainStreak = 16

/**
 * The longest prefix whose JSON string body fits `limit` bytes, measured in one
 * forward pass. A surrogate pair is admitted or refused whole, so the retained
 * text is well formed whenever the input is.
 *
 * Plain text is one byte per unit, so once a streak of it starts, the rest of
 * the run is matched natively instead of unit by unit. The match reads a window
 * one unit past the bytes still free, never the tail the cut drops.
 */
const boundedPrefix = (value: string, limit: number): { readonly text: string; readonly bytes: number } => {
  let bytes = 0
  let index = 0
  let streak = 0
  while (index < value.length) {
    if (streak >= plainStreak) {
      plainRun.lastIndex = 0
      plainRun.test(value.slice(index, index + limit - bytes + 1))
      const run = plainRun.lastIndex
      const admitted = Math.min(run, limit - bytes)
      bytes += admitted
      index += admitted
      if (admitted < run) break
      streak = 0
      continue
    }
    const code = value.charCodeAt(index)
    let width = 1
    let cost: number
    if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(value.charCodeAt(index + 1))) {
      width = 2
      cost = 4
    } else if (code >= 0xd800 && code <= 0xdfff) {
      cost = 6
    } else {
      cost = unitBytes(code)
    }
    if (bytes + cost > limit) break
    bytes += cost
    index += width
    streak = cost === 1 ? streak + 1 : 0
  }
  return { text: value.slice(0, index), bytes }
}

const boundedText = (value: string, budget: SnapshotBudget): string => {
  if (value.length <= budget.limit && reserve(budget, textBytes(value))) return value
  const markerBytes = textBytes(truncatedMarker)
  const prefix = boundedPrefix(value, Math.max(0, budget.bytes - markerBytes))
  budget.bytes = Math.max(0, budget.bytes - prefix.bytes - markerBytes)
  return `${prefix.text}${truncatedMarker}`
}

/**
 * Error fields read through the prototype chain, in the order the snapshot
 * projects them before any own data property the error added.
 */
const standardErrorKeys = ["name", "message", "stack", "cause"] as const

/** Reads inherited data fields without invoking accessors or walking forever. */
const errorField = (value: object, key: string): unknown => {
  let current: object | null = value
  for (let depth = 0; current !== null && depth <= maximumSnapshotDepth; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : unrenderableMarker
    current = Object.getPrototypeOf(current)
  }
  return current === null ? undefined : truncatedMarker
}

const snapshotValue = (
  value: unknown,
  budget: SnapshotBudget,
  ancestors: WeakSet<object>,
  depth = 0
): unknown => {
  if (budget.bytes <= 0) return truncatedMarker
  if (depth > maximumSnapshotDepth) return Redaction.depthMarker
  if (typeof value === "string") return boundedText(value, budget)
  if (typeof value === "number") {
    const projected = Number.isFinite(value) ? value : String(value)
    reserve(budget, String(projected).length)
    return projected
  }
  if (typeof value === "boolean" || value === null) {
    reserve(budget, value === null ? 4 : value ? 4 : 5)
    return value
  }
  if (typeof value === "bigint") return boundedText(`${value}n`, budget)
  if (value === undefined) return boundedText("[Undefined]", budget)
  if (typeof value === "function") return boundedText(Redaction.functionMarker, budget)
  if (typeof value === "symbol") return boundedText(Redaction.symbolMarker, budget)
  try {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return boundedText(Redaction.binaryMarker, budget)
    }
  } catch {
    return boundedText(unrenderableMarker, budget)
  }
  if (ancestors.has(value)) return boundedText("[Circular]", budget)
  ancestors.add(value)
  try {
    // Effect keeps a `Redacted` value off the wrapper, so its own members show
    // nothing; it is named instead, without running the wrapper's `toString`.
    if (Redacted.isRedacted(value)) return boundedText(redactedMarker, budget)
    if (value instanceof Date) {
      try {
        return boundedText(Date.prototype.toISOString.call(value), budget)
      } catch {
        return boundedText(unrenderableMarker, budget)
      }
    }
    if (value instanceof Error) {
      const record: Record<string, unknown> = Object.create(null)
      for (const key of standardErrorKeys.slice(0, budget.members)) {
        budget.members--
        try {
          record[key] = snapshotValue(errorField(value, key), budget, ancestors, depth + 1)
        } catch {
          record[key] = unrenderableMarker
        }
      }
      // Tagged failures (`_tag`, domain fields) and system errors (`code`,
      // `path`, `syscall`) keep their diagnostics as own data properties, so
      // the walk that projects plain records runs over the remaining keys.
      let names: ReadonlyArray<string>
      try {
        names = Object.getOwnPropertyNames(value).filter((key) =>
          !(standardErrorKeys as ReadonlyArray<string>).includes(key)
        )
      } catch {
        return record
      }
      let projected = 0
      let collided = false
      for (; projected < names.length && budget.members > 0; projected++) {
        budget.members--
        const key = names[projected]!
        const boundedKey = boundedText(key, budget)
        if (Object.hasOwn(record, boundedKey)) {
          collided = true
          continue
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        record[boundedKey] = descriptor !== undefined && "value" in descriptor
          ? snapshotValue(descriptor.value, budget, ancestors, depth + 1)
          : unrenderableMarker
      }
      if (collided || projected < names.length) record[truncatedMarker] = truncatedMarker
      return record
    }
    if (Array.isArray(value)) {
      const output: Array<unknown> = []
      const length = value.length
      for (let index = 0; index < length && budget.members > 0; index++) {
        budget.members--
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        output.push(
          descriptor === undefined || !("value" in descriptor)
            ? unrenderableMarker
            : snapshotValue(descriptor.value, budget, ancestors, depth + 1)
        )
      }
      if (output.length < length) output.push(truncatedMarker)
      return output
    }
    const record: Record<string, unknown> = Object.create(null)
    const names = Object.getOwnPropertyNames(value)
    for (let index = 0; index < names.length && budget.members > 0; index++) {
      budget.members--
      const key = names[index]!
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      const boundedKey = boundedText(key, budget)
      // A key truncated to fit the budget can read exactly like one already
      // copied. The first member keeps its slot; the later one is dropped and
      // the record is marked truncated below rather than silently overwritten.
      if (Object.hasOwn(record, boundedKey)) continue
      record[boundedKey] = descriptor !== undefined && "value" in descriptor
        ? snapshotValue(descriptor.value, budget, ancestors, depth + 1)
        : unrenderableMarker
    }
    if (Object.keys(record).length < names.length) record[truncatedMarker] = truncatedMarker
    return record
  } catch {
    return boundedText(unrenderableMarker, budget)
  } finally {
    ancestors.delete(value)
  }
}

const snapshotCause = (cause: Cause.Cause<unknown>, budget: SnapshotBudget): LogCause => ({
  version: 1,
  reasons: cause.reasons.slice(0, maximumSnapshotMembers).map((reason): CauseReason => {
    switch (reason._tag) {
      case "Fail":
        return { _tag: "Fail", error: snapshotValue(reason.error, budget, new WeakSet()) }
      case "Die":
        return { _tag: "Die", defect: snapshotValue(reason.defect, budget, new WeakSet()) }
      case "Interrupt":
        return { _tag: "Interrupt", fiberId: reason.fiberId ?? null }
    }
  })
})

const isLog = Schema.is(Log)

/**
 * Annotations are a container in the durable schema, so a snapshot that spent
 * the budget names the loss inside a record instead of replacing the record
 * with a scalar the schema refuses.
 */
const snapshotAnnotations = (value: unknown, budget: SnapshotBudget): Readonly<Record<string, unknown>> => {
  const snapshot = snapshotValue(value, budget, new WeakSet())
  return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
    ? snapshot as Readonly<Record<string, unknown>>
    : { [truncatedMarker]: truncatedMarker }
}

/**
 * The fiber's annotations without the producer's names, which the producer's
 * own values replace. An unusable reference contributes nothing beside them.
 */
const others = (
  fiberAnnotations: unknown,
  own: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> => {
  if (typeof fiberAnnotations !== "object" || fiberAnnotations === null || Array.isArray(fiberAnnotations)) return {}
  const copy: Record<string, unknown> = { ...fiberAnnotations }
  for (const key of Object.keys(own)) delete copy[key]
  return copy
}

/** The fiber's other annotations, copied only when there are any. */
const rest = (values: Readonly<Record<string, unknown>>, budget: SnapshotBudget): Readonly<Record<string, unknown>> =>
  Object.keys(values).length === 0 ? {} : snapshotAnnotations(values, budget)

/**
 * Snapshots one Effect log event into a bounded, redacted, decodable
 * {@link Log}.
 *
 * Call it from inside a logger: it is synchronous and total. The returned
 * value shares nothing with the logged one, so it can be queued for a later
 * journal write. A projection that is too large or fails {@link Log} degrades
 * to a record with a {@link truncatedMarker} message, and a projection that
 * throws degrades to one with an {@link unrenderableMarker} message; both keep
 * the level, timestamp and {@link SnapshotOptions.annotations}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const snapshot = (options: Logger.Options<unknown>, settings: SnapshotOptions = {}): Log => {
  const requested = settings.maximumBytes ?? maximumSnapshotBytes
  const limit = Number.isFinite(requested)
    ? Math.max(0, Math.min(maximumSnapshotBytes, Math.floor(requested)))
    : maximumSnapshotBytes
  const bounded = settings.maximumBytes !== undefined
  const kept = settings.annotations ?? {}
  try {
    const span = Option.getOrUndefined(Context.getOption(options.fiber.context, Tracer.ParentSpan))
    const ids = span === undefined ? {} : { traceId: span.traceId, spanId: span.spanId }
    // An explicit bound is a bound on the whole record, so the envelope around
    // the values is reserved first, with room for the marker that names
    // annotations a spent budget dropped, and a long message is cut rather
    // than costing the record its message.
    const envelope = bounded
      ? encoder.encode(JSON.stringify({
        version: 1,
        level: options.logLevel,
        message: "",
        annotations: { [truncatedMarker]: truncatedMarker },
        cause: { version: 1, reasons: [] },
        fiberId: options.fiber.id,
        ...ids,
        timestamp: options.date.toISOString()
      })).byteLength
      : 0
    const project = (room: number) => {
      const budget: SnapshotBudget = { bytes: Math.max(0, room - envelope), members: maximumSnapshotMembers, limit }
      // The producer's annotations are copied before anything the caller
      // logged, so no message can spend the budget their attribution needs.
      const own = settings.annotations === undefined ? undefined : snapshotAnnotations(settings.annotations, budget)
      const message = typeof options.message === "string" ? "" : snapshotValue(options.message, budget, new WeakSet())
      const fiberAnnotations = options.fiber.getRef(References.CurrentLogAnnotations)
      let candidate: Log = {
        version: 1,
        level: options.logLevel,
        message,
        annotations: own === undefined
          ? snapshotAnnotations(fiberAnnotations, budget)
          : { ...own, ...rest(others(fiberAnnotations, own), budget), ...own },
        cause: snapshotCause(options.cause, budget),
        fiberId: options.fiber.id,
        ...ids,
        timestamp: options.date.toISOString()
      }
      // A scalar message can spend the whole value budget. Reserve the actual
      // record envelope first so the final size check does not discard its prefix.
      if (typeof options.message === "string") {
        budget.bytes = Math.max(0, room - encoder.encode(JSON.stringify(candidate)).byteLength + 2)
        candidate = { ...candidate, message: boundedText(options.message, budget) }
      }
      const redacted = Redaction.redact(candidate, { onTooDeep: "name", rules: settings.rules }) as Log
      return { candidate, redacted, bytes: encoder.encode(JSON.stringify(redacted)).byteLength }
    }
    let projected = project(limit)
    // The budget counts values, not the JSON punctuation between them, so a
    // record under an explicit bound that still overflows is projected once
    // more with the overflow taken off; the default bound keeps one pass.
    if (bounded && projected.bytes > limit) projected = project(limit - (projected.bytes - limit) - 64)
    // The durable row is only useful if the exported schema decodes it, so an
    // oversized or schema-invalid projection degrades to the total record
    // rather than to a payload every consumer throws on.
    return projected.bytes <= limit && isLog(projected.redacted)
      ? projected.redacted
      : {
        ...projected.candidate,
        message: truncatedMarker,
        annotations: kept,
        cause: { version: 1, reasons: [] }
      }
  } catch {
    return {
      version: 1,
      level: options.logLevel,
      message: unrenderableMarker,
      annotations: kept,
      cause: { version: 1, reasons: [] },
      fiberId: options.fiber.id,
      timestamp: options.date.toISOString()
    }
  }
}
