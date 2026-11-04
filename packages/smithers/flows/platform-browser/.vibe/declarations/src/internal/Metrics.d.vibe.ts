/**
 * The leader's metrics, in a module of their own so `BrowserRuntime` exports
 * them without loading the engine.
 *
 * @since 1.0.0
 */
import * as Metric from "effect/Metric";
/**
 * Times a worker became leader.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const leaderships: Metric.Counter<number>;
/**
 * Unfinished runs a new leader found, by `outcome`: `settled`, `parked`,
 * `unfinished` or `failed` for a run it drove, `unknown-flow` for one whose
 * flow it was not given.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const wakes: Metric.Counter<number>;
/**
 * Preparations of the app's shared database a new leader ran before serving
 * it, by `outcome`: `prepared`, `failed`, or `skipped` when the engine serves
 * no app database.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const preparations: Metric.Counter<number>;
/**
 * Follower requests the leader handled, by `request` and `outcome`
 * (`replied` or `refused`).
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const requests: Metric.Counter<number>;
/**
 * Statements the leader ran on the app's shared database, by `outcome`
 * (`executed`, `failed` or `lost`), statements of a transaction an earlier
 * leader committed with them (`committed`), statements it refused because
 * this build could not prepare the database (`fenced`), and transactions it
 * rolled back because their tab ended (`abandoned`).
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const statements: Metric.Counter<number>;
