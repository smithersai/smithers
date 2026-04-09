import * as Entity from "@effect/cluster/Entity";
import * as Rpc from "@effect/rpc/Rpc";
import { Schema } from "effect";
import type { TaskDescriptor } from "../TaskDescriptor";

export const WorkerTaskKind = Schema.Literal("agent", "compute", "static");
export type WorkerTaskKind = Schema.Schema.Type<typeof WorkerTaskKind>;

export const WorkerDispatchKind = Schema.Literal("compute", "static", "legacy");
export type WorkerDispatchKind = Schema.Schema.Type<typeof WorkerDispatchKind>;

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
export type WorkerTask = Schema.Schema.Type<typeof WorkerTask>;

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

export const TaggedWorkerError = Schema.Union(
  TaskAbortedError,
  TaskTimeoutError,
  TaskHeartbeatTimeoutError,
  RunNotFoundError,
  InvalidInputError,
  DbWriteFailedError,
  AgentCliError,
  WorkflowFailedError,
);
export type TaggedWorkerError = Schema.Schema.Type<typeof TaggedWorkerError>;

const UnknownWorkerError = Schema.Struct({
  _tag: Schema.Literal("UnknownWorkerError"),
  errorId: Schema.String,
  message: Schema.String,
});
export type UnknownWorkerError = Schema.Schema.Type<typeof UnknownWorkerError>;

export const WorkerTaskError = Schema.Union(TaggedWorkerError, UnknownWorkerError);
export type WorkerTaskError = Schema.Schema.Type<typeof WorkerTaskError>;

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
export type TaskResult = Schema.Schema.Type<typeof TaskResult>;
export type TaskFailure = Extract<TaskResult, { _tag: "Failure" }>;

export const TaskWorkerEntity = Entity.make("TaskWorker", [
  Rpc.make("execute", {
    payload: WorkerTask,
    success: TaskResult,
  }),
]);

function getWorkerTaskKind(desc: TaskDescriptor): WorkerTaskKind {
  if (desc.agent) {
    return "agent";
  }
  if (desc.computeFn) {
    return "compute";
  }
  return "static";
}

export function makeWorkerTask(
  bridgeKey: string,
  workflowName: string,
  runId: string,
  desc: TaskDescriptor,
  dispatchKind: WorkerDispatchKind,
): WorkerTask {
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

export function isTaskResultFailure(
  result: TaskResult,
): result is TaskFailure {
  return result._tag === "Failure";
}

export function isUnknownWorkerError(
  error: WorkerTaskError,
): error is UnknownWorkerError {
  return error._tag === "UnknownWorkerError";
}
