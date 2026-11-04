/**
 * Content-free SQLite initialization boundaries for the browser host.
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
/**
 * SQLite initialization stages, by stage and outcome.
 * @category metrics
 * @since 1.0.0
 */
export declare const openings: Metric.Counter<number>;
/**
 * Report the storage boundary before SqlError hides its native reason. Never record paths or SQL.
 * @category observability
 * @since 1.0.0
 */
export declare const observe: <A, E, R>(stage: "build" | "opfs" | "database" | "journal", effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, import("effect/Tracer").ParentSpan>>;
