/**
 * Spans and metrics for a service record whose members are Effects or
 * Effect-returning functions.
 *
 * Attributes carry shapes only: a namespace kind, a limit, a row count. Never
 * a key, a text, or a value.
 *
 * @since 1.0.0
 */
import * as Metric from "effect/Metric";
/**
 * Memory store operations by method and outcome.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const operations: Metric.Counter<number>;
/**
 * Wraps every member of `service` in a span named `MemoryStore.<method>` and
 * counts its outcome.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const instrument: <S extends object>(service: S) => S;
