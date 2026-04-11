import type {
  ContinueAsNewHandler,
  CreateWorkflowSession,
  SchedulerWaitHandler,
  TaskExecutor,
  WaitHandler,
  WorkflowRuntime,
  WorkflowSession,
} from "../protocol/workflow-types";
import type { WorkflowDefinition } from "./WorkflowDefinition.ts";
import type { WorkflowGraphRenderer } from "./WorkflowGraphRenderer.ts";

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
