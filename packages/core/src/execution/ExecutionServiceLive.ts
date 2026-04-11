import { Effect, Layer } from "effect";
import type { TaskDescriptor } from "../graph.ts";
import type { TaskOutput } from "../session.ts";
import { fromPromise, fromSync } from "../interop/index.ts";
import { ExecutionService } from "./ExecutionService.ts";

function normalizeTaskResult(task: TaskDescriptor, output: unknown): TaskOutput {
  return {
    nodeId: task.nodeId,
    iteration: task.iteration,
    output,
  };
}

export const ExecutionServiceLive = Layer.succeed(ExecutionService, {
  execute: ({ task }) => {
    if (task.computeFn) {
      return fromPromise("execute compute task", async () =>
        normalizeTaskResult(task, await task.computeFn!()),
      );
    }
    if (task.staticPayload !== undefined) {
      return fromSync("execute static task", () =>
        normalizeTaskResult(task, task.staticPayload),
      );
    }
    return Effect.succeed(normalizeTaskResult(task, undefined));
  },
});
