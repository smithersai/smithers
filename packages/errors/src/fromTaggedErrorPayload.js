import { TaskAborted } from "./TaskAborted.js";
import { TaskTimeout } from "./TaskTimeout.js";
import { TaskHeartbeatTimeout } from "./TaskHeartbeatTimeout.js";
import { RunNotFound } from "./RunNotFound.js";
import { InvalidInput } from "./InvalidInput.js";
import { DbWriteFailed } from "./DbWriteFailed.js";
import { AgentCliError } from "./AgentCliError.js";
import { WorkflowFailed } from "./WorkflowFailed.js";
/** @typedef {import("./SmithersTaggedError.ts").SmithersTaggedError} SmithersTaggedError */
/** @typedef {import("./SmithersTaggedErrorPayload.ts").SmithersTaggedErrorPayload} SmithersTaggedErrorPayload */

/**
 * @param {SmithersTaggedErrorPayload} payload
 * @returns {SmithersTaggedError}
 */
export function fromTaggedErrorPayload(payload) {
    switch (payload._tag) {
        case "TaskAborted":
            return new TaskAborted({
                message: payload.message,
                details: payload.details,
                name: payload.name,
            });
        case "TaskTimeout":
            return new TaskTimeout({
                message: payload.message,
                nodeId: payload.nodeId,
                attempt: payload.attempt,
                timeoutMs: payload.timeoutMs,
            });
        case "TaskHeartbeatTimeout":
            return new TaskHeartbeatTimeout({
                message: payload.message,
                nodeId: payload.nodeId,
                iteration: payload.iteration,
                attempt: payload.attempt,
                timeoutMs: payload.timeoutMs,
                staleForMs: payload.staleForMs,
                lastHeartbeatAtMs: payload.lastHeartbeatAtMs,
            });
        case "RunNotFound":
            return new RunNotFound({
                message: payload.message,
                runId: payload.runId,
            });
        case "InvalidInput":
            return new InvalidInput({
                message: payload.message,
                details: payload.details,
            });
        case "DbWriteFailed":
            return new DbWriteFailed({
                message: payload.message,
                details: payload.details,
            });
        case "AgentCliError":
            return new AgentCliError({
                message: payload.message,
                details: payload.details,
            });
        case "WorkflowFailed":
            return new WorkflowFailed({
                message: payload.message,
                details: payload.details,
                status: payload.status,
            });
    }
}
