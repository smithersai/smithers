import type { TaskDescriptor } from "../graph.ts";
import type { TaskState } from "./TaskState.ts";

export function isTerminalState(
  state: TaskState,
  descriptor?: Pick<TaskDescriptor, "continueOnFail">,
): boolean {
  if (state === "finished" || state === "skipped") return true;
  if (state === "failed") return Boolean(descriptor?.continueOnFail);
  return false;
}
