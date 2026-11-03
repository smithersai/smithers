/**
 * Step logs: what an action attempt's body logs, journaled to the attempt's
 * run while it runs.
 *
 * Every log record a body emits at or above the ambient minimum level becomes
 * a `telemetry.log` journal event (`@smthrs/journal`'s `TelemetryLog.Log`) in
 * the body's run, annotated with `runId`, `stepKeyDigest` (the digest attempt
 * rows and settled nodes carry as `stepKeyDigests`) and `attempt`. The engine
 * does this on every host by default: the ambient loggers keep receiving every
 * record, and the body's log annotations gain `stepKeyDigest` for them too.
 *
 * Delivery is lossy and never blocks the body. The logger snapshots and
 * redacts a record (`Redaction.diagnosticRules`) synchronously, cuts it to
 * {@link Limits} `recordBytes`, and offers it to a bounded queue that a fiber
 * drains to the journal's lossy channel as the body runs, so a long attempt's
 * lines are readable before it ends. When the body exits, by any exit, the
 * queue is flushed for at most `flush`. A record past `records`, a full
 * queue, a journal refusal and a flush deadline each drop the record and count
 * it (`EngineStoreMetrics.stepLog`); an attempt that dropped any journals one
 * `Warn` record saying how many, with code `step_logs_dropped`. A replayed
 * step runs no body, so it writes none.
 *
 * Provide {@link Limits} to change the bounds; `records: 0` turns step logs
 * off.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"

/**
 * How much of an attempt's logging is journaled.
 *
 * @category models
 * @since 1.0.0
 */
export interface Limits {
  /** Records one attempt journals; later ones are dropped and counted. `0` turns step logs off. */
  readonly records: number
  /** Largest encoded record, in bytes; a longer message is cut with `TelemetryLog.truncatedMarker`. */
  readonly recordBytes: number
  /** Records waiting for the journal at once; a full queue drops and counts. At least 1. */
  readonly queue: number
  /** How long an exited body waits for its queued records to reach the journal, and then for the summary record. */
  readonly flush: Duration.Input
}

/**
 * The bounds every host uses unless it provides {@link Limits}: 1,000 records
 * of at most 4 KiB per attempt, 256 queued, flushed within 5 seconds.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultLimits: Limits = {
  records: 1_000,
  recordBytes: 4 * 1024,
  queue: 256,
  flush: "5 seconds"
}

/**
 * The step log bounds an attempt reads when its body starts.
 *
 * @category references
 * @since 1.0.0
 */
export const Limits: Context.Reference<Limits> = Context.Reference<Limits>("@smthrs/engine-store/StepLogs/Limits", {
  defaultValue: () => defaultLimits
})

/**
 * The journal producer every step log record is written under.
 *
 * @category constants
 * @since 1.0.0
 */
export const sourceId = "flows/engine-store/step-log"

/**
 * The `code` annotation of the summary record an attempt that dropped records
 * journals.
 *
 * @category constants
 * @since 1.0.0
 */
export const droppedCode = "step_logs_dropped"
