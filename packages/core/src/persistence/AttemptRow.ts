export type AttemptRow = {
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
