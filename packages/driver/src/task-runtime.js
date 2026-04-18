import { AsyncLocalStorage } from "node:async_hooks";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("./SmithersTaskRuntime.ts").SmithersTaskRuntime} SmithersTaskRuntime */

const storage = new AsyncLocalStorage();
/**
 * @template T
 * @param {SmithersTaskRuntime} runtime
 * @param {() => T} execute
 * @returns {T}
 */
export function withTaskRuntime(runtime, execute) {
    return storage.run(runtime, execute);
}
/**
 * @returns {SmithersTaskRuntime | undefined}
 */
export function getTaskRuntime() {
    return storage.getStore();
}
/**
 * @returns {SmithersTaskRuntime}
 */
export function requireTaskRuntime() {
    const runtime = storage.getStore();
    if (!runtime) {
        throw new SmithersError("TASK_RUNTIME_UNAVAILABLE", "Smithers task runtime is only available while a builder step is executing.");
    }
    return runtime;
}
