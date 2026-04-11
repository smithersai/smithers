import { AsyncLocalStorage } from "node:async_hooks";
import { SmithersError } from "@smithers/errors/SmithersError";

export type SmithersTaskRuntime = {
  runId: string;
  stepId: string;
  attempt: number;
  iteration: number;
  signal: AbortSignal;
  db: any;
  heartbeat: (data?: unknown) => void;
  lastHeartbeat: unknown | null;
};

const storage = new AsyncLocalStorage<SmithersTaskRuntime>();

export function withTaskRuntime<T>(
  runtime: SmithersTaskRuntime,
  execute: () => T,
): T {
  return storage.run(runtime, execute);
}

export function getTaskRuntime(): SmithersTaskRuntime | undefined {
  return storage.getStore();
}

export function requireTaskRuntime(): SmithersTaskRuntime {
  const runtime = storage.getStore();
  if (!runtime) {
    throw new SmithersError(
      "TASK_RUNTIME_UNAVAILABLE",
      "Smithers task runtime is only available while a builder step is executing.",
    );
  }
  return runtime;
}
