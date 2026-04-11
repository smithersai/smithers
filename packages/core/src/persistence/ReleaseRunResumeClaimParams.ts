export type ReleaseRunResumeClaimParams = {
  readonly runId: string;
  readonly claimOwnerId: string;
  readonly restoreRuntimeOwnerId: string | null;
  readonly restoreHeartbeatAtMs: number | null;
};
