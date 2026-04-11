export type ClaimRunForResumeParams = {
  readonly runId: string;
  readonly expectedStatus?: string;
  readonly expectedRuntimeOwnerId: string | null;
  readonly expectedHeartbeatAtMs: number | null;
  readonly staleBeforeMs: number;
  readonly claimOwnerId: string;
  readonly claimHeartbeatAtMs: number;
  readonly requireStale?: boolean;
};
