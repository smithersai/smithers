/** Execution state for a task, derived from SmithersEvent stream */
export type TaskExecutionState = {
  nodeId: string;
  iteration: number;
  status:
    | "pending"
    | "started"
    | "finished"
    | "failed"
    | "cancelled"
    | "skipped"
    | "waiting-approval"
    | "waiting-event"
    | "waiting-timer"
    | "retrying";
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: unknown;
  toolCalls: Array<{ name: string; seq: number; status?: "success" | "error" }>;
};
