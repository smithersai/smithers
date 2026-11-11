/**
 * Effect logger layers used by flows.
 *
 * Every layer that installs a sink installs it through
 * `RedactedLogger.wrap`, the journal's redaction rules over the message, the
 * cause and the log annotations, so a credential a line quotes never reaches
 * the console in clear.
 *
 * @since 0.1.0
 */

import { RedactedLogger } from "@smthrs/journal"
import * as Context from "effect/Context"
import * as Formatter from "effect/Formatter"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import type * as LogLevel from "effect/LogLevel"
import * as References from "effect/References"
import * as Tracer from "effect/Tracer"

/**
 * Options shared by the built-in logger layers.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Pins `References.MinimumLogLevel` for the whole application. Omitted, the
   * layer leaves that reference alone and Effect's own `Info` default applies.
   */
  readonly minimumLogLevel?: LogLevel.LogLevel | undefined
  /**
   * Keeps the ambient loggers alongside this one. Defaults to `false`, which
   * replaces the ambient logger set, matching Effect's own `Logger.layer`.
   */
  readonly mergeWithExisting?: boolean | undefined
}

/**
 * Installs the minimum-level reference only when the caller named a level, so
 * a layer that adds a sink does not pin the level an application chose
 * elsewhere. Effect's own default for the reference is already `Info`.
 */
const withMinimumLogLevel = (
  layer: Layer.Layer<never>,
  minimumLogLevel: LogLevel.LogLevel | undefined
): Layer.Layer<never> =>
  minimumLogLevel === undefined
    ? layer
    : Layer.merge(layer, Layer.succeed(References.MinimumLogLevel, minimumLogLevel))

const optionsWithDefaults = (options?: Options): {
  readonly minimumLogLevel: LogLevel.LogLevel | undefined
  readonly mergeWithExisting: boolean
} => ({
  minimumLogLevel: options?.minimumLogLevel,
  mergeWithExisting: options?.mergeWithExisting ?? false
})

/**
 * Replaces (or joins) the ambient logger set with `logger` behind the
 * journal's redaction rules.
 */
const redactedLayer = (
  logger: Logger.Logger<unknown, unknown>,
  options: ReturnType<typeof optionsWithDefaults>
): Layer.Layer<never> =>
  withMinimumLogLevel(
    Logger.layer([RedactedLogger.wrap(logger)], { mergeWithExisting: options.mergeWithExisting }),
    options.minimumLogLevel
  )

/**
 * Provides a human-readable development logger. The message, cause and
 * annotations pass the journal's redaction rules before the line is written.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerPrettyDev = (options?: Options): Layer.Layer<never> =>
  redactedLayer(Logger.consolePretty({ colors: "auto", mode: "auto" }), optionsWithDefaults(options))

/**
 * Effect's structured record of a log line (`Logger.formatStructured`), with
 * the current span's `trace_id` and `span_id` among its annotations when the
 * line is logged inside a span. They are the names `OtlpRelay` gives a relayed
 * record's ids, so a service's own lines and the browser records it relays
 * join on the trace. An annotation the caller set under either name wins.
 *
 * @category loggers
 * @since 1.0.0
 */
export const formatStructured = Logger.make((options) => {
  const record = Logger.formatStructured.log(options)
  const span = Context.getOrUndefined(options.fiber.context, Tracer.ParentSpan)
  if (span === undefined) return record
  return { ...record, annotations: { trace_id: span.traceId, span_id: span.spanId, ...record.annotations } }
})

/**
 * Provides one structured JSON object per log line: {@link formatStructured},
 * with the current span's ids, written to the console. The message, cause and
 * annotations pass the journal's redaction rules before the line is built.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerStructuredJson = (options?: Options): Layer.Layer<never> =>
  redactedLayer(
    Logger.withConsoleLog(Logger.map(formatStructured, Formatter.formatJson)),
    optionsWithDefaults(options)
  )

/**
 * Removes the active logger set and pins the minimum level to `None` unless
 * `options.minimumLogLevel` explicitly selects another level.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (options?: Pick<Options, "minimumLogLevel">): Layer.Layer<never> =>
  withMinimumLogLevel(
    Logger.layer([]),
    options?.minimumLogLevel ?? "None"
  )

/**
 * A logger layer that can be composed without requiring a runtime service.
 * `logger` receives each log event with the journal's redaction rules already
 * applied to its message, cause and annotations, and a redacting console.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (logger: Logger.Logger<unknown, unknown>, options?: Options): Layer.Layer<never> =>
  redactedLayer(logger, optionsWithDefaults(options))
