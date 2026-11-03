/**
 * Standard metric definitions for the durable write boundary.
 *
 * This module defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. `DurableWriter`'s retry policy updates them, so every
 * store that writes through the boundary — journal, run store, step cache,
 * engine state — lands in the same counter. No exporter ships in this
 * package; provide one — for example `@smthrs/observability` — and the
 * counter appears in it. Metrics sum over the whole process; {@link tally}
 * sums the writer-lock cost of one effect, such as one request or alarm.
 *
 * @since 0.1.0
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
/**
 * Counter over write transaction replays. Incremented once per scheduled
 * retry of a recognized transient conflict (`SQLITE_BUSY`, serialization
 * failure, deadlock), so a quiet system reads zero and a rising rate reads as
 * write contention. The attempt that finally fails past the retry budget is
 * not counted; it surfaces on the error channel instead.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const writeRetries: Metric.Counter<number>;
/**
 * Timer over how long a PostgreSQL write waited for its writer lock, from
 * its first attempt through timeouts and backoffs to holding the lock. A writable
 * `PostgresDatabase` client records one observation per transaction it
 * begins, each outermost `DurableWriter.write` and each `withTransaction`,
 * and one per savepoint that had to take a lock its transaction lacked.
 * Writes to one partition, and writes that name none, commit one at a time,
 * but this client-side timer includes BEGIN and network round trips as well
 * as contention, timeouts and backoff. A rising sum alone does not prove that
 * one lock was blocked for that duration. Read-only clients, statements outside
 * a transaction, and SQLite record nothing here.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const writerLockWait: Metric.Histogram<Duration.Duration>;
/**
 * Counter over PostgreSQL writer-lock waits that reached their client's
 * `writerLockTimeout`. Each such wait rolled its transaction back, letting
 * its server connection go, and the write tried again after a backoff. A
 * quiet system reads zero; a rising rate reads as a queue of writers longer
 * than the timeout covers, which `writerLockWait` then shows as wait time.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const writerLockTimeouts: Metric.Counter<number>;
/**
 * Timer over how long a `PostgresDatabase` statement or transaction waited
 * for a connection from its pool, one observation per wait. A wait that runs
 * past the client's `acquireWarning` also logs `postgres.connection.waiting`
 * while it waits. A rising wait reads as a pool too small for the work sent
 * through it, or as a pooler that grants no server connection.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const connectionWait: Metric.Histogram<Duration.Duration>;
/**
 * Counter over `PostgresDatabase` connections that would not open or log in:
 * a refused or timed-out connection, or a refused login. Each also logs a
 * `postgres.login.failed` warning with the error's kind. A quiet system reads
 * zero; a rising rate reads as a server or pooler refusing clients, such as a
 * compute out of connections.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const loginFailures: Metric.Counter<number>;
/**
 * What the PostgreSQL write transactions inside one {@link tally} cost.
 *
 * @category models
 * @since 1.0.0
 */
export interface WriteTally {
    /** Write transactions that took a writer lock, each retry counted. */
    readonly transactions: number;
    /**
     * Those that held the whole schema's lock, from their start or from a
     * nested write that named no partition: each committed alone, holding up
     * every other writer.
     */
    readonly schemaWide: number;
    /** Their summed {@link writerLockWait}, savepoints' locks included. */
    readonly lockWait: Duration.Duration;
    /** Longest single client-side acquisition, including its transaction open, retries and transport. */
    readonly maxLockWait: Duration.Duration;
}
/**
 * Runs `effect` and answers what its PostgreSQL write transactions cost: how
 * many took a writer lock, how many of those held the whole schema's, and how
 * long they waited for their locks in total. It
 * counts the transactions {@link writerLockWait} times, begun by `effect`'s
 * fiber or by fibers it forks, in tallies nested to any depth; a transaction
 * a fiber started elsewhere began, such as a background writer's, is not
 * counted. Read-only clients, statements outside a transaction, and SQLite
 * count nothing. When `effect` fails, so does `tally`, and the count is lost.
 *
 * @example
 * ```ts
 * import { Duration, Effect } from "effect"
 * import { DatabaseMetrics } from "@smthrs/database"
 *
 * declare const drive: Effect.Effect<void>
 *
 * const logged = Effect.flatMap(DatabaseMetrics.tally(drive), ([cost]) =>
 *   Effect.logInfo("drive").pipe(Effect.annotateLogs({
 *     transactions: cost.transactions,
 *     lockWaitMs: Duration.toMillis(cost.lockWait)
 *   })))
 * ```
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const tally: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<[tally: WriteTally, result: A], E, R>;
