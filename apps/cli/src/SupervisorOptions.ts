import type { SmithersDb } from "@smithers/db/adapter";

export type SupervisorSpawnClaim = {
    claimOwnerId: string;
    claimHeartbeatAtMs: number;
    restoreRuntimeOwnerId?: string | null;
    restoreHeartbeatAtMs?: number | null;
};

export type SupervisorDeps = {
    now: () => number;
    workflowExists: (workflowPath: string) => boolean;
    parseRuntimeOwnerPid: (
        runtimeOwnerId: string | null | undefined,
    ) => number | null;
    isPidAlive: (pid: number) => boolean;
    spawnResumeDetached: (
        workflowPath: string,
        runId: string,
        claim?: SupervisorSpawnClaim,
    ) => number | null;
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
