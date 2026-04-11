import type { TaskDescriptor } from "@smithers/graph";

export type ExecutionInput = {
  readonly task: TaskDescriptor;
  readonly signal?: AbortSignal;
};
