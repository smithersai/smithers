import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Effect, Schedule } from "effect";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
import type { SmithersDb, StaleRunRecord } from "@smithers/db/adapter";
import { fromSync } from "@smithers/driver/interop";
import { trackEvent } from "@smithers/observability/metrics";
import { isPidAlive, parseRuntimeOwnerPid } from "@smithers/engine/runtime-owner";
import { SmithersError } from "@smithers/errors";
import { resumeRunDetached } from "./resume-detached";

export const DEFAULT_SUPERVISOR_INTERVAL_MS = 10_000;
export const DEFAULT_SUPERVISOR_STALE_THRESHOLD_MS = 30_000;
export const DEFAULT_SUPERVISOR_MAX_CONCURRENT = 3;
export const SUPERVISOR_EVENT_RUN_ID = "__supervisor__";

export type RunAutoResumeSkipReason =
  | "pid-alive"
  | "missing-workflow"
  | "rate-limited";

export type SupervisorPollSummary = {
  staleCount: number;
  resumedCount: number;
  skippedCount: number;
  durationMs: number;
};

export type SupervisorOptions = {
  adapter: SmithersDb;
  pollIntervalMs?: number;
  staleThresholdMs?: number;
  maxConcurrent?: number;
  dryRun?: boolean;
  supervisorId?: string;
  supervisorRunId?: string;
  deps?: Partial<SupervisorDeps>;
};

type NormalizedSupervisorOptions = {
  adapter: SmithersDb;
  pollIntervalMs: number;
  staleThresholdMs: number;
  maxConcurrent: number;
  dryRun: boolean;
  supervisorId: string;
  supervisorRunId: string;
  deps: SupervisorDeps;
};

type SupervisorDeps = {
  now: () => number;
  workflowExists: (workflowPath: string) => boolean;
  parseRuntimeOwnerPid: (
    runtimeOwnerId: string | null | undefined,
  ) => number | null;
  isPidAlive: (pid: number) => boolean;
  spawnResumeDetached: (
    workflowPath: string,
    runId: string,
    claim?: {
      claimOwnerId: string;
      claimHeartbeatAtMs: number;
      restoreRuntimeOwnerId?: string | null;
      restoreHeartbeatAtMs?: number | null;
    },
  ) => number | null;
};

const durationMultipliers: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationMs(raw: string, fieldName: string): number {
  const input = raw.trim().toLowerCase();
  const match = input.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) {
    throw new SmithersError(
      "INVALID_DURATION",
      `Invalid ${fieldName}: "${raw}". Use formats like 500ms, 10s, 2m.`,
      { fieldName, raw },
    );
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = durationMultipliers[unit];
  const ms = Math.floor(value * multiplier);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new SmithersError(
      "INVALID_DURATION",
      `Invalid ${fieldName}: "${raw}" must be > 0.`,
      { fieldName, raw },
    );
  }
  return ms;
}

export { isPidAlive, parseRuntimeOwnerPid } from "@smithers/engine/runtime-owner";

function normalizeSupervisorOptions(
  options: SupervisorOptions,
): NormalizedSupervisorOptions {
  const deps: SupervisorDeps = {
    now: () => Date.now(),
    workflowExists: (workflowPath: string) => existsSync(workflowPath),
    parseRuntimeOwnerPid,
    isPidAlive,
    spawnResumeDetached: resumeRunDetached,
    ...options.deps,
  };

  return {
    adapter: options.adapter,
    pollIntervalMs:
      options.pollIntervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS,
    staleThresholdMs:
      options.staleThresholdMs ?? DEFAULT_SUPERVISOR_STALE_THRESHOLD_MS,
    maxConcurrent:
      options.maxConcurrent ?? DEFAULT_SUPERVISOR_MAX_CONCURRENT,
    dryRun: Boolean(options.dryRun),
    supervisorId: options.supervisorId ?? randomUUID(),
    supervisorRunId: options.supervisorRunId ?? SUPERVISOR_EVENT_RUN_ID,
    deps,
  };
}

function resolveWorkflowPath(workflowPath: string | null): string | null {
  if (!workflowPath) return null;
  return isAbsolute(workflowPath)
    ? workflowPath
    : resolve(process.cwd(), workflowPath);
}

function parseTimerFiresAtMs(metaJson?: string | null): number | null {
  if (!metaJson) return null;
  try {
    const parsed = JSON.parse(metaJson);
    const firesAt = Number(parsed?.timer?.firesAtMs);
    return Number.isFinite(firesAt) ? Math.floor(firesAt) : null;
  } catch {
    return null;
  }
}

function runHasDueTimerEffect(
  options: NormalizedSupervisorOptions,
  runId: string,
  now: number,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const nodes = yield* options.adapter.listNodesEffect(runId).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(
          `[supervisor] failed to list nodes for timer run ${runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ).pipe(Effect.as([] as any[])),
      ),
    );

    const waitingTimerNodes = (nodes as any[]).filter(
      (node) => node.state === "waiting-timer",
    );
    if (waitingTimerNodes.length === 0) {
      return false;
    }

    for (const node of waitingTimerNodes) {
      const attempts = yield* options.adapter
        .listAttemptsEffect(runId, node.nodeId, node.iteration ?? 0)
        .pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(
              `[supervisor] failed to list attempts for timer ${runId}/${node.nodeId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ).pipe(Effect.as([] as any[])),
          ),
        );
      const waitingAttempt =
        (attempts as any[]).find((attempt) => attempt.state === "waiting-timer") ??
        (attempts as any[])[0];
      const firesAtMs = parseTimerFiresAtMs(waitingAttempt?.metaJson);
      if (typeof firesAtMs === "number" && firesAtMs <= now) {
        return true;
      }
    }

    return false;
  });
}

function emitEventEffect(
  adapter: SmithersDb,
  event: SmithersEvent,
): Effect.Effect<void, never> {
  return Effect.all(
    [
      trackEvent(event),
      adapter.insertEventWithNextSeqEffect({
        runId: event.runId,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson: JSON.stringify(event),
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(
            `[supervisor] failed to persist event ${event.type}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        ),
      ),
    ],
    { discard: true },
  );
}

function emitSkipEventEffect(
  options: NormalizedSupervisorOptions,
  runId: string,
  reason: RunAutoResumeSkipReason,
): Effect.Effect<void, never> {
  return emitEventEffect(options.adapter, {
    type: "RunAutoResumeSkipped",
    runId,
    reason,
    timestampMs: options.deps.now(),
  });
}

function processCandidateEffect(
  options: NormalizedSupervisorOptions,
  staleRun: StaleRunRecord,
  staleBeforeMs: number,
): Effect.Effect<"resumed" | "skipped", never> {
  const workflowPath = resolveWorkflowPath(staleRun.workflowPath);
  const now = options.deps.now();
  const staleDurationMs =
    typeof staleRun.heartbeatAtMs === "number"
      ? Math.max(0, now - staleRun.heartbeatAtMs)
      : options.staleThresholdMs;

  const runAnnotations = {
    runId: staleRun.runId,
    staleDurationMs,
    runtimeOwnerId: staleRun.runtimeOwnerId ?? null,
  };

  const claimOwnerId = `supervisor:${options.supervisorId}`;

  return Effect.withLogSpan("supervisor:resume")(
    Effect.gen(function* () {
      if (!workflowPath || !options.deps.workflowExists(workflowPath)) {
        yield* Effect.logWarning(
          `Skipping run ${staleRun.runId}: workflow file not found at ${
            workflowPath ?? "(missing path)"
          }`,
        );
        yield* emitSkipEventEffect(options, staleRun.runId, "missing-workflow");
        return "skipped" as const;
      }

      const ownerPid = options.deps.parseRuntimeOwnerPid(
        staleRun.runtimeOwnerId,
      );
      if (ownerPid !== null && options.deps.isPidAlive(ownerPid)) {
        yield* Effect.logDebug(
          `Skipping run ${staleRun.runId}: runtime owner pid ${ownerPid} is still alive`,
        );
        yield* emitSkipEventEffect(options, staleRun.runId, "pid-alive");
        return "skipped" as const;
      }

      if (options.dryRun) {
        yield* Effect.logInfo(
          `Dry-run: would resume stale run ${staleRun.runId} (last heartbeat ${staleDurationMs}ms ago)`,
        );
        return "skipped" as const;
      }

      const claimHeartbeatAtMs = options.deps.now();
      const claimed = yield* options.adapter
        .claimRunForResumeEffect({
          runId: staleRun.runId,
          expectedRuntimeOwnerId: staleRun.runtimeOwnerId ?? null,
          expectedHeartbeatAtMs: staleRun.heartbeatAtMs ?? null,
          staleBeforeMs,
          claimOwnerId,
          claimHeartbeatAtMs,
        })
        .pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(
              `[supervisor] failed to claim run ${staleRun.runId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ).pipe(Effect.as(false)),
          ),
        );

      if (!claimed) {
        yield* Effect.logDebug(
          `Skipping run ${staleRun.runId}: claim not acquired`,
        );
        return "skipped" as const;
      }

      const spawnResult = yield* fromSync(
        `resume stale run ${staleRun.runId}`,
        () =>
          options.deps.spawnResumeDetached(workflowPath, staleRun.runId, {
            claimOwnerId,
            claimHeartbeatAtMs,
            restoreRuntimeOwnerId: staleRun.runtimeOwnerId ?? null,
            restoreHeartbeatAtMs: staleRun.heartbeatAtMs ?? null,
          }),
        {
          code: "PROCESS_SPAWN_FAILED",
          details: { runId: staleRun.runId, workflowPath },
        },
      ).pipe(
        Effect.either,
      );

      if (spawnResult._tag === "Left") {
        yield* Effect.logWarning(
          `[supervisor] failed to resume run ${staleRun.runId}: ${spawnResult.left.message}`,
        );
        yield* options.adapter
          .releaseRunResumeClaimEffect({
            runId: staleRun.runId,
            claimOwnerId,
            restoreRuntimeOwnerId: staleRun.runtimeOwnerId ?? null,
            restoreHeartbeatAtMs: staleRun.heartbeatAtMs ?? null,
          })
          .pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(
                `[supervisor] failed to release claim for run ${staleRun.runId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            ),
          );
        return "skipped" as const;
      }

      const resumePid = spawnResult.right;
      yield* Effect.logInfo(
        `Resuming stale run ${staleRun.runId} (last heartbeat ${staleDurationMs}ms ago)${
          resumePid ? ` with pid ${resumePid}` : ""
        }`,
      );

      yield* emitEventEffect(options.adapter, {
        type: "RunAutoResumed",
        runId: staleRun.runId,
        lastHeartbeatAtMs: staleRun.heartbeatAtMs ?? null,
        staleDurationMs,
        timestampMs: options.deps.now(),
      });

      return "resumed" as const;
    }).pipe(
      Effect.annotateLogs(runAnnotations),
    ),
  ).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning(
        `[supervisor] failed while processing stale run ${staleRun.runId}: ${
          String(error)
        }`,
      ).pipe(Effect.as("skipped" as const)),
    ),
  );
}

function processTimerCandidateEffect(
  options: NormalizedSupervisorOptions,
  run: any,
): Effect.Effect<"resumed" | "skipped", never> {
  const workflowPath = resolveWorkflowPath(run.workflowPath ?? null);
  const runAnnotations = {
    runId: run.runId,
    status: run.status ?? null,
    runtimeOwnerId: run.runtimeOwnerId ?? null,
  };

  return Effect.withLogSpan("supervisor:timer-resume")(
    Effect.gen(function* () {
      if (!workflowPath || !options.deps.workflowExists(workflowPath)) {
        yield* Effect.logWarning(
          `Skipping timer run ${run.runId}: workflow file not found at ${
            workflowPath ?? "(missing path)"
          }`,
        );
        yield* emitSkipEventEffect(options, run.runId, "missing-workflow");
        return "skipped" as const;
      }

      const ownerPid = options.deps.parseRuntimeOwnerPid(
        run.runtimeOwnerId,
      );
      if (ownerPid !== null && options.deps.isPidAlive(ownerPid)) {
        yield* Effect.logDebug(
          `Skipping timer run ${run.runId}: runtime owner pid ${ownerPid} is still alive`,
        );
        yield* emitSkipEventEffect(options, run.runId, "pid-alive");
        return "skipped" as const;
      }

      if (options.dryRun) {
        yield* Effect.logInfo(
          `Dry-run: would resume due timer run ${run.runId}`,
        );
        return "skipped" as const;
      }

      const spawnResult = yield* fromSync(
        `resume timer run ${run.runId}`,
        () => options.deps.spawnResumeDetached(workflowPath, run.runId),
        {
          code: "PROCESS_SPAWN_FAILED",
          details: { runId: run.runId, workflowPath },
        },
      ).pipe(Effect.either);

      if (spawnResult._tag === "Left") {
        yield* Effect.logWarning(
          `[supervisor] failed to resume timer run ${run.runId}: ${spawnResult.left.message}`,
        );
        return "skipped" as const;
      }

      const resumePid = spawnResult.right;
      yield* Effect.logInfo(
        `Resuming timer-blocked run ${run.runId}${resumePid ? ` with pid ${resumePid}` : ""}`,
      );
      return "resumed" as const;
    }).pipe(
      Effect.annotateLogs(runAnnotations),
    ),
  ).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning(
        `[supervisor] failed while processing timer run ${run.runId}: ${
          String(error)
        }`,
      ).pipe(Effect.as("skipped" as const)),
    ),
  );
}

function pollEffect(
  options: NormalizedSupervisorOptions,
): Effect.Effect<SupervisorPollSummary, never> {
  return Effect.withLogSpan("supervisor:poll")(
    Effect.gen(function* () {
      const pollStartedAtMs = options.deps.now();
      const staleBeforeMs = pollStartedAtMs - options.staleThresholdMs;
      const staleRuns = yield* options.adapter
        .listStaleRunningRunsEffect(staleBeforeMs)
        .pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(
              `[supervisor] stale-run query failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ).pipe(Effect.as([] as StaleRunRecord[])),
          ),
        );

      if (staleRuns.length === 0) {
        yield* Effect.logDebug("Supervisor poll found no stale runs");
      }

      const resumable = staleRuns.slice(0, options.maxConcurrent);
      const rateLimited = staleRuns.slice(options.maxConcurrent);

      if (rateLimited.length > 0) {
        for (const run of rateLimited) {
          yield* Effect.logDebug(
            `Skipping run ${run.runId}: rate limited (max-concurrent=${options.maxConcurrent})`,
          );
          yield* emitSkipEventEffect(options, run.runId, "rate-limited");
        }
      }

      const results = yield* Effect.all(
        resumable.map((run) => processCandidateEffect(options, run, staleBeforeMs)),
        { concurrency: options.maxConcurrent },
      );

      const staleResumedCount = results.filter((result) => result === "resumed").length;
      const staleSkippedCount =
        rateLimited.length +
        results.filter((result) => result === "skipped").length;

      const waitingTimerRuns = yield* options.adapter
        .listRunsEffect(500, "waiting-timer")
        .pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(
              `[supervisor] waiting-timer query failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ).pipe(Effect.as([] as any[])),
          ),
        );

      const timerDueChecks = yield* Effect.all(
        (waitingTimerRuns as any[]).map((run) =>
          runHasDueTimerEffect(options, run.runId, pollStartedAtMs),
        ),
        { concurrency: options.maxConcurrent },
      );
      const dueTimerRuns = (waitingTimerRuns as any[]).filter(
        (_run, index) => timerDueChecks[index],
      );

      const timerSlots = Math.max(0, options.maxConcurrent - staleResumedCount);
      const timerResumable = dueTimerRuns.slice(0, timerSlots);
      const timerRateLimited = dueTimerRuns.slice(timerSlots);
      for (const run of timerRateLimited) {
        yield* emitSkipEventEffect(options, run.runId, "rate-limited");
      }
      const timerResults = yield* Effect.all(
        timerResumable.map((run) => processTimerCandidateEffect(options, run)),
        { concurrency: options.maxConcurrent },
      );

      const resumedCount =
        staleResumedCount +
        timerResults.filter((result) => result === "resumed").length;
      const skippedCount =
        staleSkippedCount +
        timerRateLimited.length +
        timerResults.filter((result) => result === "skipped").length;
      const durationMs = Math.max(0, options.deps.now() - pollStartedAtMs);

      yield* emitEventEffect(options.adapter, {
        type: "SupervisorPollCompleted",
        runId: options.supervisorRunId,
        staleCount: staleRuns.length,
        resumedCount,
        skippedCount,
        durationMs,
        timestampMs: options.deps.now(),
      });

      return {
        staleCount: staleRuns.length,
        resumedCount,
        skippedCount,
        durationMs,
      };
    }),
  );
}

export function supervisorPollEffect(
  options: SupervisorOptions,
): Effect.Effect<SupervisorPollSummary, never> {
  return pollEffect(normalizeSupervisorOptions(options));
}

export function supervisorLoopEffect(
  options: SupervisorOptions,
): Effect.Effect<void, never> {
  const normalized = normalizeSupervisorOptions(options);

  return Effect.gen(function* () {
    yield* Effect.logInfo(
      `[supervisor] started (interval=${normalized.pollIntervalMs}ms, staleThreshold=${normalized.staleThresholdMs}ms, maxConcurrent=${normalized.maxConcurrent}, dryRun=${normalized.dryRun})`,
    );

    yield* emitEventEffect(normalized.adapter, {
      type: "SupervisorStarted",
      runId: normalized.supervisorRunId,
      pollIntervalMs: normalized.pollIntervalMs,
      staleThresholdMs: normalized.staleThresholdMs,
      timestampMs: normalized.deps.now(),
    });

    yield* pollEffect(normalized).pipe(
      Effect.repeat(
        Schedule.spaced(`${normalized.pollIntervalMs} millis`),
      ),
    );
  }).pipe(
    Effect.annotateLogs({
      component: "supervisor",
      supervisorId: normalized.supervisorId,
      pollIntervalMs: normalized.pollIntervalMs,
      staleThresholdMs: normalized.staleThresholdMs,
      maxConcurrent: normalized.maxConcurrent,
      dryRun: normalized.dryRun,
    }),
    Effect.asVoid,
  );
}
