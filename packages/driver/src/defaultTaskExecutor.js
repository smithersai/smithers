import { withAbort } from "./withAbort.js";
/** @typedef {import("@smithers-orchestrator/graph").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./workflow-types.ts").TaskExecutorContext} TaskExecutorContext */

/**
 * @param {TaskDescriptor} task
 * @param {TaskExecutorContext} context
 * @returns {Promise<unknown>}
 */
export async function defaultTaskExecutor(task, context) {
    if (typeof task.computeFn === "function") {
        return withAbort(Promise.resolve().then(() => task.computeFn()), context.signal);
    }
    if ("staticPayload" in task && task.staticPayload !== undefined) {
        return task.staticPayload;
    }
    const agent = Array.isArray(task.agent) ? task.agent[0] : task.agent;
    if (agent && typeof agent === "object") {
        const target = agent;
        for (const method of ["execute", "run", "call"]) {
            const fn = target[method];
            if (typeof fn === "function") {
                return withAbort(Promise.resolve().then(() => fn(task, context)), context.signal);
            }
        }
    }
    return task.prompt ?? null;
}
