export type RunResult = {
  readonly runId: string;
  readonly status:
    | "running"
    | "finished"
    | "failed"
    | "cancelled"
    | "continued"
    | "waiting-approval"
    | "waiting-event"
    | "waiting-timer";
  readonly output?: unknown;
  readonly error?: unknown;
  readonly nextRunId?: string;
};
