export type SmithersTaskRuntime = {
  runId: string;
  stepId: string;
  attempt: number;
  iteration: number;
  signal: AbortSignal;
  db: any;
  heartbeat: (data?: unknown) => void;
  lastHeartbeat: unknown | null;
};
