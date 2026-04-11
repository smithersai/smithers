import type { RunOptions } from "../RunOptions";

export type CreateWorkflowSessionOptions = {
  db?: unknown;
  runId: string;
  rootDir?: string;
  workflowPath?: string | null;
  options: RunOptions;
};
