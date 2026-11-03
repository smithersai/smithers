/**
 * Closes every store operation span with an `outcome` attribute, so a trace
 * viewer never sees a span that ended without saying how. `RunStore` and
 * `AttemptStore` share these observers so the guide can describe one rule.
 *
 * @since 1.0.0-rc.0
 * @private
 */
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
/**
 * Observes a store operation's exit onto its span, and, when the operation
 * has an outcome-keyed counter, updates it in the same observation: the
 * domain tag (`claimed`, `fence_lost`) on success, `failure` or `interrupt`
 * otherwise, so a span never closes without saying how and a failed write
 * still lands in the counter. `exitMetric` is the counter view carrying every
 * attribute but `outcome`, which this observer adds for a non-success exit.
 * `Effect.onExit` only reads the exit; the value, cause, and interruption
 * propagate byte-identically.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export declare const observeOutcome: <A extends {
    readonly _tag: string;
}>(metricOf?: ((outcome: A) => Metric.Metric<number, Metric.CounterState<number>>) | undefined, exitMetric?: Metric.Metric<number, Metric.CounterState<number>> | undefined) => <E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
/**
 * `observeOutcome` for operations whose success carries no domain outcome
 * tag: `create` inserts or fails, `get` returns the row or fails, and
 * `acknowledgeCancel` reports whether the guarded update matched. The span
 * still closes with `success`, `failure`, or `interrupt`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export declare const observeExit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
