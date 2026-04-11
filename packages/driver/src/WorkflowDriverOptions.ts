import type {
  ContinueAsNewHandler,
  SchedulerWaitHandler,
  TaskExecutor,
  WaitHandler,
  WorkflowRuntime,
} from "./workflow-types.ts";
import type { WorkflowDefinition } from "./WorkflowDefinition.ts";
import type { WorkflowGraphRenderer } from "./WorkflowGraphRenderer.ts";
import type {
  CreateWorkflowSession,
  WorkflowSession,
} from "@smithers/core/workflow-types";

export type WorkflowDriverOptions<Schema = unknown, Element = unknown> = {
  workflow: WorkflowDefinition<Schema, Element>;
  runtime: WorkflowRuntime;
  renderer: WorkflowGraphRenderer<Element>;
  session?: WorkflowSession;
  createSession?: CreateWorkflowSession;
  db?: unknown;
  runId?: string;
  rootDir?: string;
  workflowPath?: string | null;
  executeTask?: TaskExecutor;
  onSchedulerWait?: SchedulerWaitHandler;
  onWait?: WaitHandler;
  continueAsNew?: ContinueAsNewHandler;
};
