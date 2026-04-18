import { spawn } from "node:child_process";
import { CronExpressionParser } from "cron-parser";
import { Effect, Schedule } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { runPromise } from "./smithersRuntime.js";
import { findAndOpenDb } from "./find-db.js";
/**
 * @param {unknown} error
 */
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function acquireSchedulerDbEffect() {
    return Effect.acquireRelease(Effect.tryPromise({
        try: () => findAndOpenDb(),
        catch: (cause) => toSmithersError(cause, "find and open scheduler db"),
    }), ({ cleanup }) => Effect.sync(() => cleanup()));
}
/**
 * @param {SmithersDb} adapter
 * @param {SchedulerCronRecord} job
 * @param {number} now
 * @returns {Effect.Effect<void, never>}
 */
function processCronEffect(adapter, job, now) {
    return Effect.gen(function* () {
        yield* Effect.logInfo(`[smithers-cron] Triggering due workflow: ${job.workflowPath} (Schedule: ${job.pattern})`);
        yield* Effect.try({
            try: () => {
                const proc = spawn("bun", ["run", "src/index.js", "up", job.workflowPath, "-d"], {
                    cwd: process.cwd(),
                    detached: true,
                    stdio: "ignore",
                });
                proc.unref();
            },
            catch: (cause) => toSmithersError(cause, `spawn cron workflow ${job.cronId}`),
        });
        const nextRunAtMs = yield* Effect.try({
            try: () => {
                const interval = CronExpressionParser.parse(job.pattern);
                return interval.next().getTime();
            },
            catch: (cause) => toSmithersError(cause, `calculate next run for cron ${job.cronId}`),
        });
        yield* adapter.updateCronRunTimeEffect(job.cronId, now, nextRunAtMs);
    }).pipe(Effect.catchAll((error) => Effect.gen(function* () {
        const errorMessage = formatError(error);
        yield* Effect.logWarning(`[smithers-cron] Error processing job ${job.cronId}: ${errorMessage}`);
        const failedAtMs = Date.now();
        yield* adapter
            .updateCronRunTimeEffect(job.cronId, failedAtMs, job.nextRunAtMs ?? failedAtMs + 60_000, errorMessage)
            .pipe(Effect.catchAll((updateError) => Effect.logWarning(`[smithers-cron] Failed to record error for job ${job.cronId}: ${formatError(updateError)}`)));
    })));
}
/**
 * @param {SmithersDb} adapter
 * @returns {Effect.Effect<void, never>}
 */
function schedulerTickEffect(adapter) {
    return Effect.withLogSpan("scheduler:poll")(Effect.gen(function* () {
        const crons = yield* adapter.listCronsEffect(true).pipe(Effect.catchAll((error) => Effect.logWarning(`[smithers-cron] Tick failed: ${formatError(error)}`).pipe(Effect.as([]))));
        const now = Date.now();
        for (const job of crons) {
            if (typeof job.nextRunAtMs === "number" && now < job.nextRunAtMs) {
                continue;
            }
            yield* processCronEffect(adapter, job, now);
        }
    }));
}
/**
 * @param {number} pollIntervalMs
 */
function schedulerLoopEffect(pollIntervalMs) {
    return Effect.scoped(Effect.gen(function* () {
        const { adapter } = yield* acquireSchedulerDbEffect();
        yield* Effect.logInfo("[smithers-cron] Starting background scheduler loop...");
        yield* Effect.logInfo(`[smithers-cron] Polling every ${pollIntervalMs / 1000}s for due jobs.`);
        yield* schedulerTickEffect(adapter).pipe(Effect.repeat(Schedule.spaced(`${pollIntervalMs} millis`)));
    }).pipe(Effect.annotateLogs({ component: "scheduler" }), Effect.ensuring(Effect.logInfo("[smithers-cron] Scheduler stopped.")), Effect.interruptible, Effect.asVoid));
}
function setupAbortSignal() {
    const abort = new AbortController();
    const onSigInt = () => abort.abort();
    const onSigTerm = () => abort.abort();
    process.once("SIGINT", onSigInt);
    process.once("SIGTERM", onSigTerm);
    return {
        signal: abort.signal,
        dispose() {
            process.off("SIGINT", onSigInt);
            process.off("SIGTERM", onSigTerm);
        },
    };
}
export async function runScheduler(pollIntervalMs = 15_000) {
    const abort = setupAbortSignal();
    try {
        await runPromise(schedulerLoopEffect(pollIntervalMs), {
            signal: abort.signal,
        });
    }
    catch (error) {
        abort.dispose();
        if (abort.signal.aborted) {
            process.exit(0);
        }
        throw error;
    }
    abort.dispose();
}
