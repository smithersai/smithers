export type JsonRecord = Record<string, unknown>;
export type OutputKey = Record<string, string | number | boolean | null>;

export type Run = {
  readonly runId: string;
  readonly parentRunId?: string | null;
  readonly workflowName?: string | null;
  readonly workflowPath?: string | null;
  readonly workflowHash?: string | null;
  readonly status: string;
  readonly createdAtMs?: number;
  readonly startedAtMs?: number | null;
  readonly finishedAtMs?: number | null;
  readonly heartbeatAtMs?: number | null;
  readonly runtimeOwnerId?: string | null;
  readonly cancelRequestedAtMs?: number | null;
  readonly hijackRequestedAtMs?: number | null;
  readonly hijackTarget?: string | null;
  readonly vcsType?: string | null;
  readonly vcsRoot?: string | null;
  readonly vcsRevision?: string | null;
  readonly errorJson?: string | null;
  readonly configJson?: string | null;
};

export type RunPatch = Partial<Omit<Run, "runId">>;

export type RunAncestryRow = {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly depth: number;
};

export type Attempt = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly attempt: number;
  readonly state: string;
  readonly startedAtMs: number;
  readonly finishedAtMs?: number | null;
  readonly heartbeatAtMs?: number | null;
  readonly heartbeatDataJson?: string | null;
  readonly errorJson?: string | null;
  readonly jjPointer?: string | null;
  readonly responseText?: string | null;
  readonly jjCwd?: string | null;
  readonly cached?: boolean;
  readonly metaJson?: string | null;
};

export type AttemptPatch = Partial<
  Omit<Attempt, "runId" | "nodeId" | "iteration" | "attempt">
>;

export type FrameRow = {
  readonly runId: string;
  readonly frameNo: number;
  readonly xmlJson?: string | null;
  readonly graphJson?: string | null;
  readonly xmlHash?: string | null;
  readonly xmlEncoding?: string | null;
  readonly createdAtMs?: number;
  readonly [key: string]: unknown;
};

export type SignalInsertRow = {
  readonly runId: string;
  readonly signalName: string;
  readonly correlationId: string | null;
  readonly payloadJson: string;
  readonly receivedAtMs: number;
  readonly receivedBy?: string | null;
};

export type EventRow = {
  readonly runId: string;
  readonly seq: number;
  readonly timestampMs: number;
  readonly type: string;
  readonly payloadJson: string;
};

export type EventInsertRow = Omit<EventRow, "seq">;

export type RalphRow = {
  readonly runId: string;
  readonly ralphId: string;
  readonly iteration: number;
  readonly done?: boolean;
  readonly stateJson?: string | null;
  readonly updatedAtMs?: number;
};

export type SandboxRow = {
  readonly runId: string;
  readonly sandboxId: string;
  readonly [key: string]: unknown;
};

export type ToolCallRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly [key: string]: unknown;
};

export type CronRow = {
  readonly cronId: string;
  readonly pattern?: string;
  readonly workflowPath?: string;
  readonly enabled?: boolean;
  readonly lastRunAtMs?: number | null;
  readonly nextRunAtMs?: number | null;
  readonly errorJson?: string | null;
  readonly [key: string]: unknown;
};

export type ScorerResultRow = {
  readonly runId: string;
  readonly nodeId?: string;
  readonly scorerId?: string;
  readonly scoredAtMs?: number;
  readonly [key: string]: unknown;
};

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

export type ReleaseRunResumeClaimParams = {
  readonly runId: string;
  readonly claimOwnerId: string;
  readonly restoreRuntimeOwnerId: string | null;
  readonly restoreHeartbeatAtMs: number | null;
};

export type UpdateClaimedRunParams = {
  readonly runId: string;
  readonly expectedRuntimeOwnerId: string;
  readonly expectedHeartbeatAtMs: number | null;
  readonly patch: RunPatch;
};
