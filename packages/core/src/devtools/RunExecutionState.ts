import type { TaskExecutionState } from "./TaskExecutionState.ts";

/** Execution state for a run, aggregated from SmithersEvent stream */
export type RunExecutionState = {
  runId: string;
  status:
    | "running"
    | "finished"
    | "failed"
    | "cancelled"
    | "waiting-approval"
    | "waiting-timer";
  frameNo: number;
  tasks: Map<string, TaskExecutionState>;
  events: Array<{ type: string; timestampMs: number; [key: string]: unknown }>;
  startedAt?: number;
  finishedAt?: number;
};
