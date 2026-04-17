// @smithers-type-exports-begin
/** @typedef {import("./TaggedWorkerError.ts").TaggedWorkerError} TaggedWorkerError */
/** @typedef {import("./TaskFailure.ts").TaskFailure} TaskFailure */
/** @typedef {import("./TaskResult.ts").TaskResult} TaskResult */
/** @typedef {import("./UnknownWorkerError.ts").UnknownWorkerError} UnknownWorkerError */
/** @typedef {import("./WorkerDispatchKind.ts").WorkerDispatchKind} WorkerDispatchKind */
/** @typedef {import("./WorkerTask.ts").WorkerTask} WorkerTask */
/** @typedef {import("./WorkerTaskError.ts").WorkerTaskError} WorkerTaskError */
/** @typedef {import("./WorkerTaskKind.ts").WorkerTaskKind} WorkerTaskKind */
// @smithers-type-exports-end

import * as Entity from "@effect/cluster/Entity";
import * as Rpc from "@effect/rpc/Rpc";
import { Schema } from "effect";
/** @typedef {import("@smithers/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor */

export const WorkerTaskKind = Schema.Literal("agent", "compute", "static");
export const WorkerDispatchKind = Schema.Literal("compute", "static", "legacy");
export const WorkerTask = Schema.Struct({
    executionId: Schema.String,
    bridgeKey: Schema.String,
    workflowName: Schema.String,
    runId: Schema.String,
    nodeId: Schema.String,
    iteration: Schema.Number,
    retries: Schema.Number,
    taskKind: WorkerTaskKind,
    dispatchKind: WorkerDispatchKind,
});
const WorkerErrorDetails = Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
});
const TaskAbortedError = Schema.Struct({
    _tag: Schema.Literal("TaskAborted"),
    message: Schema.String,
    details: Schema.optional(WorkerErrorDetails),
    name: Schema.optional(Schema.String),
});
const TaskTimeoutError = Schema.Struct({
    _tag: Schema.Literal("TaskTimeout"),
    message: Schema.String,
    nodeId: Schema.String,
    attempt: Schema.Number,
    timeoutMs: Schema.Number,
});
const TaskHeartbeatTimeoutError = Schema.Struct({
    _tag: Schema.Literal("TaskHeartbeatTimeout"),
    message: Schema.String,
    nodeId: Schema.String,
    iteration: Schema.Number,
    attempt: Schema.Number,
    timeoutMs: Schema.Number,
    staleForMs: Schema.Number,
    lastHeartbeatAtMs: Schema.Number,
});
const RunNotFoundError = Schema.Struct({
    _tag: Schema.Literal("RunNotFound"),
    message: Schema.String,
    runId: Schema.String,
});
const InvalidInputError = Schema.Struct({
    _tag: Schema.Literal("InvalidInput"),
    message: Schema.String,
    details: Schema.optional(WorkerErrorDetails),
});
const DbWriteFailedError = Schema.Struct({
    _tag: Schema.Literal("DbWriteFailed"),
    message: Schema.String,
    details: Schema.optional(WorkerErrorDetails),
});
const AgentCliError = Schema.Struct({
    _tag: Schema.Literal("AgentCliError"),
    message: Schema.String,
    details: Schema.optional(WorkerErrorDetails),
});
const WorkflowFailedError = Schema.Struct({
    _tag: Schema.Literal("WorkflowFailed"),
    message: Schema.String,
    details: Schema.optional(WorkerErrorDetails),
    status: Schema.optional(Schema.Number),
});
export const TaggedWorkerError = Schema.Union(TaskAbortedError, TaskTimeoutError, TaskHeartbeatTimeoutError, RunNotFoundError, InvalidInputError, DbWriteFailedError, AgentCliError, WorkflowFailedError);
const UnknownWorkerError = Schema.Struct({
    _tag: Schema.Literal("UnknownWorkerError"),
    errorId: Schema.String,
    message: Schema.String,
});
export const WorkerTaskError = Schema.Union(TaggedWorkerError, UnknownWorkerError);
const TaskSuccess = Schema.Struct({
    _tag: Schema.Literal("Success"),
    executionId: Schema.String,
    terminal: Schema.Boolean,
});
const TaskFailure = Schema.Struct({
    _tag: Schema.Literal("Failure"),
    executionId: Schema.String,
    error: WorkerTaskError,
});
export const TaskResult = Schema.Union(TaskSuccess, TaskFailure);
export const TaskWorkerEntity = Entity.make("TaskWorker", [
    Rpc.make("execute", {
        payload: WorkerTask,
        success: TaskResult,
    }),
]);
/**
 * @param {TaskDescriptor} desc
 * @returns {WorkerTaskKind}
 */
function getWorkerTaskKind(desc) {
    if (desc.agent) {
        return "agent";
    }
    if (desc.computeFn) {
        return "compute";
    }
    return "static";
}
/**
 * @param {string} bridgeKey
 * @param {string} workflowName
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {WorkerDispatchKind} dispatchKind
 * @returns {WorkerTask}
 */
export function makeWorkerTask(bridgeKey, workflowName, runId, desc, dispatchKind) {
    return {
        executionId: bridgeKey,
        bridgeKey,
        workflowName,
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        retries: desc.retries,
        taskKind: getWorkerTaskKind(desc),
        dispatchKind,
    };
}
/**
 * @param {TaskResult} result
 * @returns {result is TaskFailure}
 */
export function isTaskResultFailure(result) {
    return result._tag === "Failure";
}
/**
 * @param {WorkerTaskError} error
 * @returns {error is UnknownWorkerError}
 */
export function isUnknownWorkerError(error) {
    return error._tag === "UnknownWorkerError";
}
