/**
 * Effect metric registry for flows runtime signals.
 *
 * @since 0.1.0
 */
import * as Metric from "effect/Metric";
/**
 * Counts flow runs that reached a terminal state.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const runThroughput: Metric.Counter<number>;
/**
 * The number of execution seats currently held.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const activeSeats: Metric.Gauge<number>;
/**
 * Counts runs parked because a quota was exhausted.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const quotaParks: Metric.Counter<number>;
/**
 * Counts agent answers refused by their declared output schema.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export declare const structuredOutputRejections: Metric.Counter<number>;
/**
 * Counts agent steps that failed after spending every output correction.
 *
 * @category metrics
 * @since 1.0.0-rc.1
 */
export declare const structuredOutputExhausted: Metric.Counter<number>;
/**
 * Counts operational log records lost before durable delivery.
 *
 * Advances once per record dropped by a saturated forwarding queue, once per
 * journal delivery failure, and once per defect the forwarding worker recovers
 * from, so telemetry loss is distinguishable from an idle logger.
 *
 * @category metrics
 * @since 1.0.0-rc.0
 */
export declare const droppedLogRecords: Metric.Counter<number>;
/**
 * Counts OTLP records `OtlpRelay.serve` re-emitted as log lines, by `signal`.
 *
 * @category metrics
 * @since 1.0.0-rc.16
 */
export declare const relayedRecords: Metric.Counter<number>;
/**
 * Counts OTLP records `OtlpRelay.serve` dropped, by `signal` and `reason`:
 * `not_allowed` for a record its allowlist does not name, `over_limit` for one
 * over its per-request cap.
 *
 * @category metrics
 * @since 1.0.0-rc.16
 */
export declare const relayDroppedRecords: Metric.Counter<number>;
/**
 * All metrics declared by this package.
 *
 * @category registry
 * @since 0.1.0
 */
export declare const registry: {
    readonly runThroughput: Metric.Counter<number>;
    readonly activeSeats: Metric.Gauge<number>;
    readonly quotaParks: Metric.Counter<number>;
    readonly structuredOutputRejections: Metric.Counter<number>;
    readonly structuredOutputExhausted: Metric.Counter<number>;
    readonly droppedLogRecords: Metric.Counter<number>;
    readonly relayedRecords: Metric.Counter<number>;
    readonly relayDroppedRecords: Metric.Counter<number>;
};
