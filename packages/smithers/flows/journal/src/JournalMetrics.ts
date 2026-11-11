/**
 * Standard metric definitions for the journal write path.
 *
 * This module defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. `SqlJournal` updates them as emission receipts are
 * produced, so the counters measure admissions on the hot path rather than
 * rows read back. No exporter ships in this package; provide one, for
 * example `@smthrs/observability`, and these counters appear in it. The
 * counters sum over the whole process; {@link tally} counts the entries one
 * effect, such as one request or alarm, committed.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import * as EventTally from "./internal/EventTally.ts"

/**
 * Counter over journal emissions, dimensioned by `channel` (`durable` or
 * `lossy`) and `receipt` (`accepted`, `duplicate`, or `dropped`).
 *
 * **Details**
 *
 * A `durable` emission counts when its receipt is produced, which is after the
 * write transaction returned; under `Journal.transact` that is still inside
 * the caller's transaction, so a receipt that later rolls back with the
 * enclosing transaction has already counted. The counter is throughput
 * evidence, not commit evidence: the journal rows themselves are the latter.
 *
 * @category metrics
 * @since 0.1.0
 */
export const writes = Metric.counter("flows_journal_writes", {
  description: "Journal emissions by channel and receipt"
})

/**
 * `writes` views for the durable channel, keyed by the receipt tag
 * `Journal.emitDurable` resolves to.
 *
 * @category metrics
 * @since 0.1.0
 */
export const durable: {
  readonly [Tag in "Accepted" | "Duplicate"]: Metric.Metric<number, Metric.CounterState<number>>
} = {
  Accepted: Metric.withAttributes(writes, { channel: "durable", receipt: "accepted" }),
  Duplicate: Metric.withAttributes(writes, { channel: "durable", receipt: "duplicate" })
}

/**
 * `writes` views for the lossy channel, keyed by the receipt tag
 * `Journal.emitLossy` resolves to.
 *
 * @category metrics
 * @since 0.1.0
 */
export const lossy: {
  readonly [Tag in "Accepted" | "Duplicate" | "Dropped"]: Metric.Metric<number, Metric.CounterState<number>>
} = {
  Accepted: Metric.withAttributes(writes, { channel: "lossy", receipt: "accepted" }),
  Duplicate: Metric.withAttributes(writes, { channel: "lossy", receipt: "duplicate" }),
  Dropped: Metric.withAttributes(writes, { channel: "lossy", receipt: "dropped" })
}

/**
 * Counter over queued entries the writer admitted and then failed to commit,
 * dimensioned by `channel` (`lossy` or `deferred`) and the `code` of the
 * `JournalError` that lost them.
 *
 * **Details**
 *
 * A lossy producer rarely calls `flush`, so the failure `flush` reports is not
 * where an operator learns about a lost batch. This counter moves by the number
 * of entries lost the moment the writer gives them up, whether or not anyone
 * is waiting on them.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const lostEntries = Metric.counter("flows_journal_lost", {
  description: "Admitted journal entries the writer failed to commit"
})

/**
 * The lossy-channel {@link lostEntries} view for one `JournalError` code.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export const lost = (code: string): Metric.Metric<number, Metric.CounterState<number>> =>
  Metric.withAttributes(lostEntries, { channel: "lossy", code })

/**
 * What one {@link tally} wrote to the journal.
 *
 * @category models
 * @since 1.0.0
 */
export interface JournalTally {
  /** New entries committed, counted after their transaction commits; a duplicate is not new. */
  readonly events: number
}

/**
 * Runs `effect` and answers how many new journal entries it committed. An
 * entry counts once its transaction commits, when the journal publishes it,
 * so one rolled back with an enclosing transaction never counts. It counts
 * the entries committed by `effect`'s fiber or by fibers it forks, in
 * tallies nested to any depth. Lossy entries commit on the journal's own
 * writer fiber and are not counted. When `effect` fails, so does `tally`.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { JournalMetrics } from "@smthrs/journal"
 *
 * declare const drive: Effect.Effect<void>
 *
 * const logged = Effect.flatMap(JournalMetrics.tally(drive), ([written]) =>
 *   Effect.logInfo("drive").pipe(Effect.annotateLogs({ events: written.events })))
 * ```
 *
 * @category metrics
 * @since 1.0.0
 */
export const tally = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<[tally: JournalTally, result: A], E, R> =>
  Effect.gen(function*() {
    const accumulator: EventTally.Accumulator = { events: 0 }
    const open = yield* EventTally.Current
    const result = yield* Effect.provideService(effect, EventTally.Current, [...open, accumulator])
    return [{ events: accumulator.events }, result]
  })
