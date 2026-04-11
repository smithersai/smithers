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

export type RunRow = Run;
