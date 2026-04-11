export type AttemptRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  state: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  heartbeatAtMs: number | null;
  heartbeatDataJson: string | null;
  errorJson: string | null;
  jjPointer: string | null;
  responseText: string | null;
  jjCwd: string | null;
  cached: boolean;
  metaJson: string | null;
};
