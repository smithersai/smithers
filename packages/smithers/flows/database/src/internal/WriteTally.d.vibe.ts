/**
 * The open `DatabaseMetrics.tally` scopes of the current fiber.
 *
 * @since 1.0.0
 */
import { Context, Duration, Effect } from "effect";
/**
 * One open tally: what the writes inside it cost so far.
 *
 * @category internal
 * @since 1.0.0
 */
export interface Accumulator {
    transactions: number;
    schemaWide: number;
    lockWait: Duration.Duration;
    maxLockWait: Duration.Duration;
}
/**
 * Which writer lock a statement waited for: a transaction's first, on the
 * whole schema or on one partition; a savepoint's first widening of a
 * partitioned transaction to the schema; or any other savepoint lock, which
 * joins a partition or widens again after a rollback released the first.
 *
 * @category internal
 * @since 1.0.0
 */
export type Wait = "schema" | "partition" | "widen" | "more";
/**
 * Every tally the current fiber runs inside, innermost last. A fiber forked
 * inside a tally inherits it, so its writes count too.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const Current: Context.Reference<readonly Accumulator[]>;
/**
 * Adds one wait of `waited` for the writer lock `wait` names to every open
 * tally: a transaction's first lock counts the transaction, and a lock on the
 * whole schema counts it as schema-wide.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const record: (waited: Duration.Duration, wait: Wait) => Effect.Effect<void>;
