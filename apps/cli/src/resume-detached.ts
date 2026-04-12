/**
 * Resume an existing run by launching `smithers up ... --resume` as a detached process.
 * Returns the spawned PID when available.
 */
export declare function resumeRunDetached(workflowPath: string, runId: string, claim?: {
    claimOwnerId: string;
    claimHeartbeatAtMs: number;
    restoreRuntimeOwnerId?: string | null;
    restoreHeartbeatAtMs?: number | null;
}): number | null;
