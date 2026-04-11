import type { RunOptions } from "../RunOptions";
import type { CreateWorkflowSessionOptions } from "./CreateWorkflowSessionOptions";

export type CreateWorkflowSession = (
  opts: CreateWorkflowSessionOptions,
) => unknown;
