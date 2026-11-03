/**
 * Write retry policy.
 *
 * Governing persistence design: `docs/concepts/write-boundary.md`.
 *
 * Retry
 * only structured transient failures, bound exponential delay, and use Effect
 * scheduling so interruption and `TestClock` remain native.
 *
 * Classification is dialect-blind by construction. `DurableWriter.make`
 * accepts any `SqlClient`, so a caller can already hand it a Postgres or
 * PGlite client; keying only off SQLite codes made the retry silently inert
 * there, and a serialization failure — the normal, expected outcome of two
 * drivers fencing one run — surfaced as a hard write error (issue #78). Both
 * vocabularies are recognised, and a code from the wrong dialect simply never
 * matches.
 *
 * @since 0.1.0
 */
import { Effect } from "effect";
import * as SqlError from "effect/sql/SqlError";
import type * as DurableWriter from "../../../../src/DurableWriter.ts";
/**
 * Configuration for write retries.
 *
 * @category models
 * @since 0.1.0
 */
export interface WriteRetryOptions {
    /** Total attempts, including the initial write. */
    readonly maxAttempts?: number | undefined;
    /** Initial exponential backoff delay in milliseconds. */
    readonly baseDelayMs?: number | undefined;
    /** Upper bound for a single retry delay in milliseconds. */
    readonly maxDelayMs?: number | undefined;
}
/**
 * Returns whether a cause chain carries a recognized transient database
 * conflict.
 *
 * @category guards
 * @since 1.0.0
 */
export declare const isBusyCause: (cause: unknown) => boolean;
/**
 * Returns whether a cause chain carries a recognized SQLite I/O failure.
 *
 * @category guards
 * @since 1.0.0
 */
export declare const isIoCause: (cause: unknown) => boolean;
/**
 * Returns whether a cause chain names a table or column the database does not
 * have: SQLite's `no such table` / `no such column`, or PostgreSQL's
 * `undefined_table` / `undefined_column`. A store written by an older schema
 * answers this way to a statement a newer binary issues.
 *
 * @category guards
 * @since 1.0.0
 */
export declare const isSchemaCause: (cause: unknown) => boolean;
/**
 * The stable category a structured SQL failure normalizes to.
 *
 * Every code `DurableWriter.DatabaseError` reports except `unsupported`, which
 * a refused open raises before any statement runs and no classifier here can
 * produce. Derived rather than restated so the two cannot drift.
 *
 * @category models
 * @since 1.0.0
 */
export type SqlFailureCode = Exclude<DurableWriter.DatabaseErrorCode, "unsupported">;
/**
 * Classifies a structured SQL error once, for both the retry decision and the
 * code `DurableWriter.DatabaseError` reports.
 *
 * One function rather than two predicates, because the two used to disagree on
 * a mixed cause chain: an `SQLITE_IOERR` whose own cause carried `SQLITE_BUSY`
 * was reported as `io` — the category the package documents as never replayed
 * — and retried anyway. Precedence is decided here, in one place, so a code and
 * a retry decision can no longer drift apart: a lock timeout is always busy, a
 * constraint violation is never transient, and an I/O failure outranks a busy
 * cause nested beneath it, because the write did reach the disk.
 *
 * @category classifying
 * @since 1.0.0
 */
export declare const classifySqlError: (error: SqlError.SqlError) => SqlFailureCode;
/**
 * The category SQL provenance in a cause chain normalizes to, including a
 * redacted normalized error, or `undefined` when the chain carries none.
 *
 * @category classifying
 * @since 1.0.0
 */
export declare const findFailureCode: (error: unknown) => DurableWriter.DatabaseErrorCode | undefined;
/**
 * Returns whether a failure represents a transient write conflict in either
 * the SQLite or the Postgres vocabulary. The failure may be
 * the structured SQL error, a normalized DatabaseError, or a domain error wrapping one — the walk
 * follows `cause` chains (and a `SqlError`'s reason cause) either way, so the
 * outermost `DurableWriter.write` still replays a transaction whose failing
 * savepoint a nested store already normalized into its own error type.
 * Constraint, syntax, and arbitrary application errors are deliberately never
 * retried, and neither is an I/O failure with a busy cause beneath it: the
 * classification {@link classifySqlError} makes is the whole decision.
 *
 * A defect is judged by this same function, so a raw throw qualifies only when
 * it carries SQL or normalized database provenance too.
 *
 * @category guards
 * @since 0.1.0
 */
export declare const isRetryableWriteError: (error: unknown) => boolean;
/**
 * Retries recognized transient write errors using exponential backoff and
 * jitter. Delays use Effect's Clock and therefore work with TestClock.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const withWriteRetry: <A, E, R>(effect: Effect.Effect<A, E, R>, options?: WriteRetryOptions | undefined) => Effect.Effect<A, E, R>;
