import type { TaskDescriptor } from "@smithers/graph/types";
import type { TaskExecutorContext } from "./TaskExecutorContext";

export type TaskExecutor = (
  task: TaskDescriptor,
  context: TaskExecutorContext,
) => Promise<unknown> | unknown;
