import type { TaskDescriptor } from "@smithers/graph";
import type { TaskExecutorContext } from "../protocol/workflow-types";
import { withAbort } from "./withAbort.ts";

export async function defaultTaskExecutor(
  task: TaskDescriptor,
  context: TaskExecutorContext,
): Promise<unknown> {
  if (typeof task.computeFn === "function") {
    return withAbort(Promise.resolve().then(() => task.computeFn!()), context.signal);
  }
  if ("staticPayload" in task && task.staticPayload !== undefined) {
    return task.staticPayload;
  }
  const agent = Array.isArray(task.agent) ? task.agent[0] : task.agent;
  if (agent && typeof agent === "object") {
    const target = agent as Record<string, unknown>;
    for (const method of ["execute", "run", "call"]) {
      const fn = target[method];
      if (typeof fn === "function") {
        return withAbort(
          Promise.resolve().then(() =>
            (fn as (task: TaskDescriptor, context: TaskExecutorContext) => unknown)(
              task,
              context,
            ),
          ),
          context.signal,
        );
      }
    }
  }
  return task.prompt ?? null;
}
