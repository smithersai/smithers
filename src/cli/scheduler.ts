import { spawn } from "node:child_process";
import { CronExpressionParser } from "cron-parser";
import { Effect, Schedule } from "effect";
import type { SmithersDb } from "../db/adapter";
import { fromPromise, fromSync } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { findAndOpenDb } from "./find-db";

type SchedulerCronRecord = {
  cronId: string;
  workflowPath: string;
  pattern: string;
  nextRunAtMs: number | null;
};

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function acquireSchedulerDbEffect() {
  return Effect.acquireRelease(
    fromPromise("find and open scheduler db", () => findAndOpenDb()),
    ({ cleanup }) => Effect.sync(() => cleanup()),
  );
}

function processCronEffect(
  adapter: SmithersDb,
  job: SchedulerCronRecord,
  now: number,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    yield* Effect.logInfo(
      `[smithers-cron] Triggering due workflow: ${job.workflowPath} (Schedule: ${job.pattern})`,
    );

    yield* fromSync(`spawn cron workflow ${job.cronId}`, () => {
      const proc = spawn(
        "bun",
        ["run", "src/cli/index.ts", "up", job.workflowPath, "-d"],
        {
          cwd: process.cwd(),
          detached: true,
          stdio: "ignore",
        },
      );
      proc.unref();
    });

    const nextRunAtMs = yield* fromSync(
      `calculate next run for cron ${job.cronId}`,
      () => {
        const interval = CronExpressionParser.parse(job.pattern);
        return interval.next().getTime();
      },
    );

    yield* adapter.updateCronRunTimeEffect(job.cronId, now, nextRunAtMs);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const errorMessage = formatError(error);
        yield* Effect.logWarning(
          `[smithers-cron] Error processing job ${job.cronId}: ${errorMessage}`,
        );

        const failedAtMs = Date.now();
        yield* adapter
          .updateCronRunTimeEffect(
            job.cronId,
            failedAtMs,
            job.nextRunAtMs ?? failedAtMs + 60_000,
            errorMessage,
          )
          .pipe(
            Effect.catchAll((updateError) =>
              Effect.logWarning(
                `[smithers-cron] Failed to record error for job ${job.cronId}: ${formatError(updateError)}`,
              ),
            ),
          );
      }),
    ),
  );
}

function schedulerTickEffect(
  adapter: SmithersDb,
): Effect.Effect<void, never> {
  return Effect.withLogSpan("scheduler:poll")(
    Effect.gen(function* () {
      const crons = yield* adapter.listCronsEffect(true).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(
            `[smithers-cron] Tick failed: ${formatError(error)}`,
          ).pipe(Effect.as([] as SchedulerCronRecord[])),
        ),
      );

      const now = Date.now();
      for (const job of crons as SchedulerCronRecord[]) {
        if (typeof job.nextRunAtMs === "number" && now < job.nextRunAtMs) {
          continue;
        }
        yield* processCronEffect(adapter, job, now);
      }
    }),
  );
}

function schedulerLoopEffect(
  pollIntervalMs: number,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const { adapter } = yield* acquireSchedulerDbEffect();

      yield* Effect.logInfo(
        "[smithers-cron] Starting background scheduler loop...",
      );
      yield* Effect.logInfo(
        `[smithers-cron] Polling every ${pollIntervalMs / 1000}s for due jobs.`,
      );

      yield* schedulerTickEffect(adapter).pipe(
        Effect.repeat(
          Schedule.spaced(`${pollIntervalMs} millis`),
        ),
      );
    }).pipe(
      Effect.annotateLogs({ component: "scheduler" }),
      Effect.ensuring(
        Effect.logInfo("[smithers-cron] Scheduler stopped."),
      ),
      Effect.interruptible,
      Effect.asVoid,
    ),
  );
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
  } catch (error) {
    abort.dispose();
    if (abort.signal.aborted) {
      process.exit(0);
    }
    throw error;
  }

  abort.dispose();
}
