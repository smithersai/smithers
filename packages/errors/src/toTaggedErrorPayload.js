import { isSmithersTaggedError } from "./isSmithersTaggedError.js";
/** @typedef {import("./TaggedErrorDetails.ts").TaggedErrorDetails} TaggedErrorDetails */

/** @typedef {import("./SmithersTaggedErrorPayload.ts").SmithersTaggedErrorPayload} SmithersTaggedErrorPayload */

/**
 * @param {unknown} value
 * @returns {value is TaggedErrorDetails}
 */
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/**
 * @param {unknown} error
 * @returns {SmithersTaggedErrorPayload | undefined}
 */
export function toTaggedErrorPayload(error) {
    if (!isSmithersTaggedError(error)) {
        return undefined;
    }
    switch (error._tag) {
        case "TaskAborted":
            return {
                _tag: "TaskAborted",
                message: String(error.message),
                details: isRecord(error.details)
                    ? error.details
                    : undefined,
                name: typeof error.name === "string" ? error.name : undefined,
            };
        case "TaskTimeout":
            return {
                _tag: "TaskTimeout",
                message: String(error.message),
                nodeId: String(error.nodeId),
                attempt: Number(error.attempt),
                timeoutMs: Number(error.timeoutMs),
            };
        case "TaskHeartbeatTimeout":
            return {
                _tag: "TaskHeartbeatTimeout",
                message: String(error.message),
                nodeId: String(error.nodeId),
                iteration: Number(error.iteration),
                attempt: Number(error.attempt),
                timeoutMs: Number(error.timeoutMs),
                staleForMs: Number(error.staleForMs),
                lastHeartbeatAtMs: Number(error.lastHeartbeatAtMs),
            };
        case "RunNotFound":
            return {
                _tag: "RunNotFound",
                message: String(error.message),
                runId: String(error.runId),
            };
        case "InvalidInput":
            return {
                _tag: "InvalidInput",
                message: String(error.message),
                details: isRecord(error.details)
                    ? error.details
                    : undefined,
            };
        case "DbWriteFailed":
            return {
                _tag: "DbWriteFailed",
                message: String(error.message),
                details: isRecord(error.details)
                    ? error.details
                    : undefined,
            };
        case "AgentCliError":
            return {
                _tag: "AgentCliError",
                message: String(error.message),
                details: isRecord(error.details)
                    ? error.details
                    : undefined,
            };
        case "WorkflowFailed":
            return {
                _tag: "WorkflowFailed",
                message: String(error.message),
                details: isRecord(error.details)
                    ? error.details
                    : undefined,
                status: typeof error.status === "number"
                    ? error.status
                    : undefined,
            };
    }
}
