import type { TaskDescriptor } from "../graph.ts";

export type ExecutionInput = {
  readonly task: TaskDescriptor;
  readonly signal?: AbortSignal;
};
