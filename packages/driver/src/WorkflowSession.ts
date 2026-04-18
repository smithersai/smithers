import type { WorkflowGraph } from "@smithers-orchestrator/graph/types";
import type { TaskCompletedEvent } from "./TaskCompletedEvent.ts";
import type { TaskFailedEvent } from "./TaskFailedEvent.ts";

export type WorkflowSession = {
  submitGraph(graph: WorkflowGraph): unknown;
  taskCompleted(event: TaskCompletedEvent): unknown;
  taskFailed(event: TaskFailedEvent): unknown;
  getNextDecision?(): unknown;
  cancelRequested?(): unknown;
};
