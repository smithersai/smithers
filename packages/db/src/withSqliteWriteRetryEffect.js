import { Duration, Effect, Metric, Schedule, ScheduleDecision, ScheduleIntervals, } from "effect";
import { dbRetries } from "@smithers-orchestrator/observability/metrics";
import { retryPolicyToSchedule } from "@smithers-orchestrator/scheduler/retryPolicyToSchedule";
import { isRetryableSqliteWriteError } from "./isRetryableSqliteWriteError.js";
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("./SqliteWriteRetryOptions.ts").SqliteWriteRetryOptions} SqliteWriteRetryOptions */

// Raised from 6→10 and 2000→10000: concurrent Worktree tasks can produce
// short bursts of SQLITE_IOERR_VNODE on macOS; more retries with a wider
// window gives busy_timeout time to clear the VFS lock.
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BASE_DELAY_MS = 50;
const DEFAULT_MAX_DELAY_MS = 10_000;
/**
 * @param {unknown} error
 * @returns {string}
 */
function describeSqliteWriteError(error) {
    const metadata = findSqliteErrorMetadata(error);
    const code = metadata?.code ?? "";
    const message = metadata?.message || String(error?.message ?? error ?? "unknown error");
    return code ? `${code}: ${message}` : message;
}
/**
 * @param {unknown} error
 * @returns {SqliteErrorMetadata | null}
 */
function readSqliteErrorMetadata(error) {
    if (!error || (typeof error !== "object" && !(error instanceof Error))) {
        return null;
    }
    const code = typeof error?.code === "string" ? error.code : "";
    const message = String(error?.message ?? "");
    return { code, message };
}
/**
 * @param {unknown} error
 * @returns {SqliteErrorMetadata | null}
 */
function findSqliteErrorMetadata(error) {
    const seen = new Set();
    let current = error;
    while (current && !seen.has(current)) {
        seen.add(current);
        const metadata = readSqliteErrorMetadata(current);
        if (metadata) {
            const message = metadata.message.toLowerCase();
            if (metadata.code.startsWith("SQLITE_BUSY") ||
                metadata.code.startsWith("SQLITE_IOERR") ||
                message.includes("database is locked") ||
                message.includes("database is busy") ||
                message.includes("disk i/o error")) {
                return metadata;
            }
        }
        current = current?.cause;
    }
    return readSqliteErrorMetadata(error);
}
/**
 * @param {number} maxAttempts
 * @param {number} baseDelayMs
 * @param {number} maxDelayMs
 */
function makeSqliteRetrySchedule(maxAttempts, baseDelayMs, maxDelayMs) {
    const boundedBaseDelayMs = Math.max(1, Math.floor(baseDelayMs));
    const boundedMaxDelayMs = Math.max(1, Math.floor(maxDelayMs));
    return retryPolicyToSchedule({
        backoff: "exponential",
        initialDelayMs: boundedBaseDelayMs,
    }).pipe(Schedule.modifyDelay((_, delay) => Duration.millis(Math.min(boundedMaxDelayMs, Duration.toMillis(delay)))), Schedule.jitteredWith({ min: 0.75, max: 1.25 }), Schedule.whileInput(isRetryableSqliteWriteError), Schedule.intersect(Schedule.recurs(Math.max(0, maxAttempts - 1))));
}
/**
 * @template A
 * @param {() => Effect.Effect<A, SmithersError>} operation
 * @param {SqliteWriteRetryOptions} [opts]
 * @returns {Effect.Effect<A, SmithersError>}
 */
export function withSqliteWriteRetryEffect(operation, opts = {}) {
    const { label = "sqlite write", maxAttempts = DEFAULT_MAX_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS, sleep, } = opts;
    const boundedMaxAttempts = Math.max(1, Math.floor(maxAttempts));
    let retryAttempt = 0;
    let lastRetryError;
    const retrySchedule = Schedule.mapInput(makeSqliteRetrySchedule(boundedMaxAttempts, baseDelayMs, maxDelayMs), (error) => {
        lastRetryError = error;
        return error;
    }).pipe(Schedule.onDecision((_, decision) => {
        if (ScheduleDecision.isDone(decision) || !lastRetryError) {
            return Effect.void;
        }
        retryAttempt += 1;
        const delayMs = Math.max(1, Math.round(ScheduleIntervals.start(decision.intervals) - Date.now()));
        return Effect.gen(function* () {
            yield* Metric.increment(dbRetries);
            yield* Effect.logWarning(`${label} failed with ${describeSqliteWriteError(lastRetryError)}; retrying in ${delayMs}ms (${retryAttempt}/${boundedMaxAttempts})`);
            if (sleep) {
                yield* Effect.promise(() => sleep(delayMs));
            }
        }).pipe(Effect.annotateLogs({
            retryable: true,
            retryAttempt,
            retryMaxAttempts: boundedMaxAttempts,
            retryDelayMs: delayMs,
            retryLabel: label,
        }));
    }));
    return Effect.suspend(operation).pipe(Effect.retry(sleep
        ? Schedule.modifyDelay(retrySchedule, () => Duration.zero)
        : retrySchedule), Effect.withLogSpan("sqlite-write-retry"));
}
