import type { WorkflowGraph } from "@smithers/graph/types";
import type { TaskCompletedEvent } from "./TaskCompletedEvent";
import type { TaskFailedEvent } from "./TaskFailedEvent";

export type WorkflowSession = {
  submitGraph(graph: WorkflowGraph): unknown;
  taskCompleted(event: TaskCompletedEvent): unknown;
  taskFailed(event: TaskFailedEvent): unknown;
  getNextDecision?(): unknown;
  cancelRequested?(): unknown;
};
