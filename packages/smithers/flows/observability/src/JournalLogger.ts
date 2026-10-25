/**
 * Non-blocking forwarding of bounded operational logs to the durable journal.
 *
 * @since 0.1.0
 */

import { Journal, JournalEvent, TelemetryLog as Telemetry } from "@smthrs/journal"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import type * as LogLevel from "effect/LogLevel"
import * as EffectMetric from "effect/Metric"
import * as Queue from "effect/Queue"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import { schemaIssuePath } from "./internal/schemaIssuePath.ts"
import { droppedLogRecords } from "./Metric.ts"

/**
 * Largest queue accepted by the forwarding logger.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumCapacity = 65_536

/**
 * Largest detached log payload admitted to the asynchronous queue.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumSnapshotBytes = Telemetry.maximumSnapshotBytes

/**
 * Largest number of container members copied into one detached log payload.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumSnapshotMembers = Telemetry.maximumSnapshotMembers

/**
 * Deepest container path copied into one detached log payload.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumSnapshotDepth = Telemetry.maximumSnapshotDepth

/**
 * What a hostile or unreadable logged value becomes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const unrenderableMarker = Telemetry.unrenderableMarker

/**
 * What a value beyond a logger resource ceiling becomes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const truncatedMarker = Telemetry.truncatedMarker

/**
 * Options for the journal forwarding logger.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  /** The run every forwarded record is attributed to. */
  readonly runId: JournalEvent.RunId
  /** Queue depth, 1 through {@link maximumCapacity}. Defaults to 256. */
  readonly capacity?: number | undefined
  /**
   * Pins `References.MinimumLogLevel` for the whole application. Omitted, the
   * layer leaves that reference alone and Effect's own `Info` default applies.
   */
  readonly minimumLogLevel?: LogLevel.LogLevel | undefined
  /**
   * Keeps the ambient loggers alongside the forwarder. Defaults to `false`,
   * which replaces the ambient logger set.
   */
  readonly mergeWithExisting?: boolean | undefined
}

/**
 * A stable logger configuration refusal.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class InvalidJournalLoggerOptions extends Schema.TaggedError<InvalidJournalLoggerOptions>()(
  "@smthrs/observability/InvalidJournalLoggerOptions",
  {
    code: Schema.Literal("invalid_journal_logger_options"),
    path: Schema.String,
    message: Schema.String
  }
) {}

/**
 * One typed failure retained from an Effect cause. The same schema as
 * `@smthrs/journal`'s `Telemetry.Fail`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryFail = Telemetry.Fail

/**
 * One unexpected defect retained from an Effect cause. The same schema as
 * `@smthrs/journal`'s `Telemetry.Die`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryDie = Telemetry.Die

/**
 * One interruption retained from an Effect cause. The same schema as
 * `@smthrs/journal`'s `Telemetry.Interrupt`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryInterrupt = Telemetry.Interrupt

/**
 * One reason in a persisted telemetry cause. The same schema as
 * `@smthrs/journal`'s `Telemetry.CauseReason`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryCauseReason = Telemetry.CauseReason

/**
 * One reason in a persisted telemetry cause.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryCauseReason = Telemetry.CauseReason

/**
 * A versioned structural Effect cause. The same schema as `@smthrs/journal`'s
 * `Telemetry.LogCause`.
 *
 * Effect 4 stores composed failures as an ordered reason list. The projection
 * preserves that order and each fail, defect, or interrupt discriminator.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryCause = Telemetry.LogCause

/**
 * A versioned structural Effect cause.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryCause = Telemetry.LogCause

/**
 * Runtime schema for the operational log payload written to the journal. The
 * same schema as `@smthrs/journal`'s `TelemetryLog.Log`, which also builds it.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryLog = Telemetry.Log

/**
 * Versioned operational log payload written to the journal.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryLog = Telemetry.Log

const sourceId = "flows/observability/logger" as JournalEvent.SourceId

const OptionsSchema = Schema.Struct({
  runId: JournalEvent.RunId,
  capacity: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(maximumCapacity)
    )
  ),
  minimumLogLevel: Schema.optional(
    Schema.Literals(["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"])
  ),
  mergeWithExisting: Schema.optional(Schema.Boolean)
})

const validateOptions = (options: Options) =>
  Schema.decodeUnknownEffect(OptionsSchema)(options).pipe(
    Effect.mapError((cause) => {
      const path = schemaIssuePath(cause, "options")
      return new InvalidJournalLoggerOptions({
        code: "invalid_journal_logger_options",
        path,
        message: `journal logger ${path} is invalid`
      })
    })
  )

const makeLog = (options: Logger.Options<unknown>, runId: JournalEvent.RunId): JournalEvent.Input =>
  new JournalEvent.Input({
    runId,
    sourceId,
    // The journal owns the durable per-run/source allocation. A local counter
    // starts over when a layer is rebuilt and makes distinct records collide.
    eventType: Telemetry.eventType,
    payload: Telemetry.snapshot(options),
    meta: {
      version: 1,
      source: "/observability"
    }
  })

/**
 * Installs a bounded, drop-on-overflow logger forwarder for one explicit run.
 *
 * Configuration is decoded before a worker starts. The callback reads the
 * queue's remaining room first, snapshots and redacts a bounded DTO
 * synchronously only when a slot is free, then performs only non-blocking
 * queue admission. A record a saturated queue cannot take is counted and
 * discarded without being snapshotted. Queue overflow, journal `Dropped` receipts, delivery failures,
 * and journal defects each advance `Metric.droppedLogRecords`. The two failure
 * paths also warn through the ambient loggers with a fixed code and run id,
 * and the worker keeps draining. `Accepted` and `Duplicate` do not advance the
 * counter. Admission receipts cannot identify later drop-oldest evictions of
 * these records or report asynchronous persistence failures or shutdown losses.
 * Closing the scope interrupts the worker and may drop records still queued
 * behind an in-flight write without advancing the counter.
 *
 * The layer replaces the ambient logger set unless `mergeWithExisting` is
 * `true`, and provides `MinimumLogLevel` only when `minimumLogLevel` is given,
 * so an application that set that reference elsewhere keeps it.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerJournalForwarding = (
  options: Options
): Layer.Layer<never, InvalidJournalLoggerOptions, Journal.Journal> =>
  Layer.unwrap(
    Effect.map(validateOptions(options), (configured) =>
      Layer.merge(
        Layer.effect(
          Logger.CurrentLoggers,
          Effect.gen(function*() {
            const journal = yield* Journal.Journal
            const queue = yield* Queue.bounded<JournalEvent.Input>(configured.capacity ?? 256)
            const dropped = EffectMetric.update(droppedLogRecords, 1)
            // This worker is forked before the logger it feeds is installed, so
            // its ambient logger set cannot contain that logger and a warning
            // here cannot enqueue itself. Delivery stays lossy; the loss is
            // reported and counted instead of vanishing. Warning annotations
            // use fixed codes so ambient sinks never receive raw failures.
            const forward = Effect.fn("JournalLogger.forward")((input: JournalEvent.Input) =>
              journal.emitLossy(input).pipe(
                Effect.tap((receipt) => receipt._tag === "Dropped" ? dropped : Effect.void),
                Effect.catch(() =>
                  dropped.pipe(
                    Effect.andThen(
                      Effect.annotateLogs(Effect.logWarning("A telemetry log record could not be forwarded"), {
                        runId: configured.runId,
                        code: "journal_forwarding_failed"
                      })
                    )
                  )
                )
              )
            )
            yield* Effect.forever(
              Queue.take(queue).pipe(
                Effect.flatMap(forward),
                // A defect from a journal implementation would otherwise end
                // this fiber for the rest of the run, silently, while the layer
                // still looks installed. Interruption stays fatal.
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : dropped.pipe(
                      Effect.andThen(
                        Effect.annotateLogs(
                          Effect.logWarning("The telemetry forwarding worker recovered from a defect"),
                          { runId: configured.runId, code: "journal_forwarding_defect" }
                        )
                      )
                    )
                )
              )
            ).pipe(Effect.forkScoped)

            const logger = Logger.make<unknown, void>((logOptions) => {
              // Snapshotting and redacting the record is the expensive half of
              // admission, and saturation is exactly when that work is thrown
              // away, so a queue with no room refuses before the record is
              // built. Nothing else runs between this read and the offer, so
              // the check cannot refuse a record the queue would have taken,
              // and the offer still reports a queue that closed underneath it.
              const accepted = !Queue.isFullUnsafe(queue)
                && Queue.offerUnsafe(queue, makeLog(logOptions, configured.runId))
              if (!accepted) droppedLogRecords.updateUnsafe(1, logOptions.fiber.context)
            })
            const current = yield* Effect.withFiber((fiber) => Effect.sync(() => fiber.getRef(Logger.CurrentLoggers)))
            return new Set(configured.mergeWithExisting === true ? current : []).add(logger)
          })
        ),
        configured.minimumLogLevel === undefined
          ? Layer.empty
          : Layer.succeed(References.MinimumLogLevel, configured.minimumLogLevel)
      ))
  )
