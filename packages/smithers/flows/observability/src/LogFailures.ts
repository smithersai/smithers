/**
 * Counts what went wrong from the log: every line at `Warn` or above, by its
 * record, its code and its area, and keeps the latest of them.
 *
 * A program that logs each failure once, by a stable record name and a code,
 * gets its failures counted without a counter at every call site: install
 * {@link layer} beside the program's exporter and each `Effect.logWarning`,
 * `Effect.logError` or `Effect.logFatal` adds one to {@link failures}. The
 * latest lines stay in memory for a report through {@link Recent}.
 *
 * Nothing it keeps can carry what someone wrote: a record is the line's
 * message only when the program names it (`records`), a code is an
 * annotation's identifier or a failure's tag or name, never a message, and
 * every value set is capped, so a careless line costs `other`, never a new
 * series.
 *
 * @since 1.0.0-rc.17
 */

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as LogLevel from "effect/LogLevel"
import * as Metric from "effect/Metric"
import * as References from "effect/References"
import * as Tracer from "effect/Tracer"

/**
 * What {@link layer} counts and keeps.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Options {
  /**
   * The record names a line keeps as its `record`: its message, when it is
   * one of these. Any other line counts as `other`. Omitted, a message of up
   * to 96 letters, digits, spaces and `_ . : ' / @ -` is kept, up to
   * {@link maxRecords} distinct ones.
   */
  readonly records?: Iterable<string> | undefined
  /**
   * The annotations read for a line's code, first present first. Defaults to
   * {@link defaultCodeFields}. Without one, the code is the tag or name of
   * the first failure or defect in the line's cause, else `none`.
   */
  readonly codes?: ReadonlyArray<string> | undefined
  /** The annotation naming a line's area. Defaults to `feature`; absent, `none`. */
  readonly area?: string | undefined
  /** How many of the latest lines {@link Recent} keeps. Defaults to 50. */
  readonly keep?: number | undefined
}

/**
 * One line {@link Recent} kept: when, how bad, its record, code and area, and
 * the span it was logged in, if any.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Entry {
  /** Epoch milliseconds, from the program's clock. */
  readonly at: number
  readonly level: "warn" | "error" | "fatal"
  readonly record: string
  readonly code: string
  readonly area: string
  readonly traceId?: string
  readonly spanId?: string
}

/**
 * The latest lines at `Warn` or above, oldest first, from the {@link layer}
 * that provides it.
 *
 * @category services
 * @since 1.0.0-rc.17
 */
export class Recent extends Context.Service<Recent, {
  readonly entries: Effect.Effect<ReadonlyArray<Entry>>
}>()("@smthrs/observability/LogFailures/Recent") {}

/**
 * Lines logged at `Warn` or above, by `level` (`warn`, `error`, `fatal`),
 * `record`, `code` and `area`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export const failures = Metric.counter("flows_observability_log_failures", {
  description: "Log lines at Warn or above, by record, code and area",
  incremental: true
})

/**
 * The annotations read for a line's code when {@link Options.codes} is
 * omitted, first present first.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const defaultCodeFields: ReadonlyArray<string> = [
  "errorCode",
  "code",
  "reason",
  "outcome",
  "error.type",
  "error",
  "name",
  "status"
]

/**
 * Distinct records kept when {@link Options.records} is omitted; past it a
 * new one reads `other`.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export const maxRecords = 200

/**
 * Distinct codes kept; past it a new one reads `other`.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export const maxCodes = 200

/**
 * Distinct areas kept; past it a new one reads `other`.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export const maxAreas = 50

const recordPattern = /^[A-Za-z0-9_ .:'/@-]{1,96}$/
const identifier = /^[A-Za-z0-9_.:/@-]{1,64}$/

/** A value set that keeps at most `limit` distinct values; past it a new one reads `other`. */
const bounded = (limit: number) => {
  const seen = new Set<string>()
  return (value: string): string => {
    if (seen.has(value)) return value
    if (seen.size >= limit) return "other"
    seen.add(value)
    return value
  }
}

/** An annotation's value as a code: an identifier, or a finite number such as a status. */
const asCode = (value: unknown): string | undefined =>
  typeof value === "string" && identifier.test(value)
    ? value
    : typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined

/** A failure's code: its `code`, its `_tag`, or its name when it isn't plain `Error`. Never its message. */
const codeOfValue = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as { readonly code?: unknown; readonly _tag?: unknown; readonly name?: unknown }
  return asCode(record.code) ?? asCode(record._tag) ?? (record.name === "Error" ? undefined : asCode(record.name))
}

const codeOfCause = (cause: Cause.Cause<unknown>): string | undefined => {
  for (const reason of cause.reasons) {
    const code = Cause.isFailReason(reason)
      ? codeOfValue(reason.error)
      : Cause.isDieReason(reason)
      ? codeOfValue(reason.defect)
      : undefined
    if (code !== undefined) return code
  }
  return undefined
}

const levels = { Warn: "warn", Error: "error", Fatal: "fatal" } as const

/**
 * Installs the counting logger beside the program's other loggers and
 * provides {@link Recent}. Each line at `Warn` or above adds one to
 * {@link failures} and becomes the newest {@link Entry}.
 *
 * Provide it above the layer that installs the exporter, so the logger set it
 * extends already holds the exporter's logger.
 *
 * @category layers
 * @since 1.0.0-rc.17
 */
export const layer = (options?: Options): Layer.Layer<Recent> =>
  Layer.unwrap(Effect.sync(() => {
    const allowed = options?.records === undefined ? undefined : new Set(options.records)
    const codeFields = options?.codes ?? defaultCodeFields
    const areaField = options?.area ?? "feature"
    const keep = Math.max(0, Math.floor(options?.keep ?? 50))
    const record = bounded(maxRecords)
    const code = bounded(maxCodes)
    const area = bounded(maxAreas)
    const entries: Array<Entry> = []

    // Effect hands a logger the line's arguments, its causes taken out; the first names the record.
    const recordOf = (message: unknown): string => {
      const first = (message as ReadonlyArray<unknown>)[0]
      if (typeof first !== "string") return "other"
      if (allowed !== undefined) return allowed.has(first) ? first : "other"
      return recordPattern.test(first) ? record(first) : "other"
    }

    const logger = Logger.make<unknown, void>(({ cause, date, fiber, logLevel, message }) => {
      if (!LogLevel.isGreaterThanOrEqualTo(logLevel, "Warn")) return
      const level = levels[logLevel as keyof typeof levels]
      const annotations = fiber.getRef(References.CurrentLogAnnotations)
      let annotated: string | undefined
      for (const field of codeFields) {
        annotated = asCode(annotations[field])
        if (annotated !== undefined) break
      }
      const found = annotated ?? codeOfCause(cause)
      const rawArea = annotations[areaField]
      const attributes = {
        level,
        record: recordOf(message),
        code: found === undefined ? "none" : code(found),
        area: typeof rawArea === "string" && identifier.test(rawArea) ? area(rawArea) : "none"
      }
      Metric.withAttributes(failures, attributes).updateUnsafe(1, fiber.context)
      if (keep === 0) return
      const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan)
      entries.push({
        at: date.getTime(),
        ...attributes,
        ...(span === undefined ? {} : { traceId: span.traceId, spanId: span.spanId })
      })
      if (entries.length > keep) entries.shift()
    })

    return Layer.merge(
      Logger.layer([logger], { mergeWithExisting: true }),
      Layer.succeed(Recent, Recent.of({ entries: Effect.sync(() => entries.slice()) }))
    )
  }))
