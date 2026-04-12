import { SmithersError } from "./SmithersError.js";
/**
 * @param {unknown} value
 * @returns {TaggedErrorPayload | undefined}
 */
function objectPayload(value) {
    return value && typeof value === "object"
        ? value
        : undefined;
}
/**
 * @param {unknown} error
 * @returns {SmithersError | undefined}
 */
export function fromTaggedError(error) {
    const payload = objectPayload(error);
    if (!payload || typeof payload._tag !== "string")
        return undefined;
    const message = typeof payload.message === "string" ? payload.message : String(payload._tag);
    const cause = error && typeof error === "object" && "cause" in error
        ? error.cause
        : undefined;
    const details = payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)
        ? payload.details
        : undefined;
    switch (payload._tag) {
        case "TaskAborted":
            return new SmithersError("TASK_ABORTED", message, details, {
                cause,
                name: typeof payload.name === "string" ? payload.name : undefined,
            });
        case "TaskTimeout":
            return new SmithersError("TASK_TIMEOUT", message, {
                nodeId: payload.nodeId,
                attempt: payload.attempt,
                timeoutMs: payload.timeoutMs,
            }, { cause });
        case "TaskHeartbeatTimeout":
            return new SmithersError("TASK_HEARTBEAT_TIMEOUT", message, {
                nodeId: payload.nodeId,
                iteration: payload.iteration,
                attempt: payload.attempt,
                timeoutMs: payload.timeoutMs,
                staleForMs: payload.staleForMs,
                lastHeartbeatAtMs: payload.lastHeartbeatAtMs,
            }, { cause });
        case "RunNotFound":
            return new SmithersError("RUN_NOT_FOUND", message, { runId: payload.runId }, { cause });
        case "InvalidInput":
            return new SmithersError("INVALID_INPUT", message, details, { cause });
        case "DbWriteFailed":
            return new SmithersError("DB_WRITE_FAILED", message, details, { cause });
        case "AgentCliError":
            return new SmithersError("AGENT_CLI_ERROR", message, details, { cause });
        case "WorkflowFailed":
            return new SmithersError("WORKFLOW_EXECUTION_FAILED", message, {
                ...details,
                ...(payload.status === undefined ? {} : { status: payload.status }),
            }, { cause });
        default:
            return undefined;
    }
}
