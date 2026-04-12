import type {
  ContinueAsNewHandler,
  CreateWorkflowSession,
  SchedulerWaitHandler,
  TaskExecutor,
  WaitHandler,
  WorkflowRuntime,
  WorkflowSession,
} from "./workflow-types.ts";
import type { WorkflowDefinition } from "./WorkflowDefinition.ts";
import type { WorkflowGraphRenderer } from "./WorkflowGraphRenderer.ts";

export type WorkflowDriverOptions<Schema = unknown> = {
  workflow: WorkflowDefinition<Schema>;
  runtime: WorkflowRuntime;
  renderer: WorkflowGraphRenderer;
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
