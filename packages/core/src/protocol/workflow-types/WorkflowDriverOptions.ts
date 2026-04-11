import type { ExtractOptions, WorkflowGraph } from "@smithers/graph/types";
import type { CreateWorkflowSession } from "./CreateWorkflowSession";
import type { ContinueAsNewHandler } from "./ContinueAsNewHandler";
import type { SchedulerWaitHandler } from "./SchedulerWaitHandler";
import type { TaskExecutor } from "./TaskExecutor";
import type { WaitHandler } from "./WaitHandler";
import type { Workflow } from "./Workflow";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import type { WorkflowSession } from "./WorkflowSession";

export type WorkflowDriverOptions<Schema = unknown, Element = unknown> = {
  workflow: Workflow<Schema, Element>;
  runtime: WorkflowRuntime;
  renderer?: {
    render(
      element: Element,
      opts?: ExtractOptions,
    ): Promise<WorkflowGraph> | WorkflowGraph;
  };
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
