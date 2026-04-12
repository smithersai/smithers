import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
export declare const DEFAULT_SUPERVISOR_INTERVAL_MS = 10000;
export declare const DEFAULT_SUPERVISOR_STALE_THRESHOLD_MS = 30000;
export declare const DEFAULT_SUPERVISOR_MAX_CONCURRENT = 3;
export declare const SUPERVISOR_EVENT_RUN_ID = "__supervisor__";
export type RunAutoResumeSkipReason = "pid-alive" | "missing-workflow" | "rate-limited";
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
type SupervisorDeps = {
    now: () => number;
    workflowExists: (workflowPath: string) => boolean;
    parseRuntimeOwnerPid: (runtimeOwnerId: string | null | undefined) => number | null;
    isPidAlive: (pid: number) => boolean;
    spawnResumeDetached: (workflowPath: string, runId: string, claim?: {
        claimOwnerId: string;
        claimHeartbeatAtMs: number;
        restoreRuntimeOwnerId?: string | null;
        restoreHeartbeatAtMs?: number | null;
    }) => number | null;
};
export declare function parseDurationMs(raw: string, fieldName: string): number;
export { isPidAlive, parseRuntimeOwnerPid } from "@smithers/engine/runtime-owner";
export declare function supervisorPollEffect(options: SupervisorOptions): Effect.Effect<SupervisorPollSummary, never>;
export declare function supervisorLoopEffect(options: SupervisorOptions): Effect.Effect<void, never>;
