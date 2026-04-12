import * as Entity from "@effect/cluster/Entity";
import * as Rpc from "@effect/rpc/Rpc";
import { Schema } from "effect";
import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
export declare const WorkerTaskKind: Schema.Literal<["agent", "compute", "static"]>;
export type WorkerTaskKind = Schema.Schema.Type<typeof WorkerTaskKind>;
export declare const WorkerDispatchKind: Schema.Literal<["compute", "static", "legacy"]>;
export type WorkerDispatchKind = Schema.Schema.Type<typeof WorkerDispatchKind>;
export declare const WorkerTask: Schema.Struct<{
    executionId: typeof Schema.String;
    bridgeKey: typeof Schema.String;
    workflowName: typeof Schema.String;
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    retries: typeof Schema.Number;
    taskKind: Schema.Literal<["agent", "compute", "static"]>;
    dispatchKind: Schema.Literal<["compute", "static", "legacy"]>;
}>;
export type WorkerTask = Schema.Schema.Type<typeof WorkerTask>;
export declare const TaggedWorkerError: Schema.Union<[Schema.Struct<{
    _tag: Schema.Literal<["TaskAborted"]>;
    message: typeof Schema.String;
    details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    name: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    _tag: Schema.Literal<["TaskTimeout"]>;
    message: typeof Schema.String;
    nodeId: typeof Schema.String;
    attempt: typeof Schema.Number;
    timeoutMs: typeof Schema.Number;
}>, Schema.Struct<{
    _tag: Schema.Literal<["TaskHeartbeatTimeout"]>;
    message: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    attempt: typeof Schema.Number;
    timeoutMs: typeof Schema.Number;
    staleForMs: typeof Schema.Number;
    lastHeartbeatAtMs: typeof Schema.Number;
}>, Schema.Struct<{
    _tag: Schema.Literal<["RunNotFound"]>;
    message: typeof Schema.String;
    runId: typeof Schema.String;
}>, Schema.Struct<{
    _tag: Schema.Literal<["InvalidInput"]>;
    message: typeof Schema.String;
    details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
}>, Schema.Struct<{
    _tag: Schema.Literal<["DbWriteFailed"]>;
    message: typeof Schema.String;
    details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
}>, Schema.Struct<{
    _tag: Schema.Literal<["AgentCliError"]>;
    message: typeof Schema.String;
    details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
}>, Schema.Struct<{
    _tag: Schema.Literal<["WorkflowFailed"]>;
    message: typeof Schema.String;
    details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    status: Schema.optional<typeof Schema.Number>;
}>]>;
export type TaggedWorkerError = Schema.Schema.Type<typeof TaggedWorkerError>;
declare const UnknownWorkerError: Schema.Struct<{
    _tag: Schema.Literal<["UnknownWorkerError"]>;
    errorId: typeof Schema.String;
    message: typeof Schema.String;
}>;
export type UnknownWorkerError = Schema.Schema.Type<typeof UnknownWorkerError>;
export declare const WorkerTaskError: Schema.Union<[Schema.Union<[Schema.Struct<{
    _tag: Schema.Literal<["TaskAborted"]>;
    message: typeof Schema.String;
    details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    name: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    _tag: Schema.Literal<["TaskTimeout"]>;
    message: typeof Schema.String;
    nodeId: typeof Schema.String;
    attempt: typeof Schema.Number;
    timeoutMs: typeof Schema.Number;
}>, Schema.Struct<{
    _tag: Schema.Literal<["TaskHeartbeatTimeout"]>;
    message: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    attempt: typeof Schema.Number;
    timeoutMs: typeof Schema.Number;
    staleForMs: typeof Schema.Number;
    lastHeartbeatAtMs: typeof Schema.Number;
}>, Schema.Struct<{
    _tag: Schema.Literal<["RunNotFound"]>;
    message: typeof Schema.String;
    runId: typeof Schema.String;
}>, Schema.Struct<{
    _tag: Schema.Literal<["InvalidInput"]>;
    message: typeof Schema.String;
    details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
}>, Schema.Struct<{
    _tag: Schema.Literal<["DbWriteFailed"]>;
    message: typeof Schema.String;
    details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
}>, Schema.Struct<{
    _tag: Schema.Literal<["AgentCliError"]>;
    message: typeof Schema.String;
    details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
}>, Schema.Struct<{
    _tag: Schema.Literal<["WorkflowFailed"]>;
    message: typeof Schema.String;
    details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    status: Schema.optional<typeof Schema.Number>;
}>]>, Schema.Struct<{
    _tag: Schema.Literal<["UnknownWorkerError"]>;
    errorId: typeof Schema.String;
    message: typeof Schema.String;
}>]>;
export type WorkerTaskError = Schema.Schema.Type<typeof WorkerTaskError>;
export declare const TaskResult: Schema.Union<[Schema.Struct<{
    _tag: Schema.Literal<["Success"]>;
    executionId: typeof Schema.String;
    terminal: typeof Schema.Boolean;
}>, Schema.Struct<{
    _tag: Schema.Literal<["Failure"]>;
    executionId: typeof Schema.String;
    error: Schema.Union<[Schema.Union<[Schema.Struct<{
        _tag: Schema.Literal<["TaskAborted"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
        name: Schema.optional<typeof Schema.String>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["TaskTimeout"]>;
        message: typeof Schema.String;
        nodeId: typeof Schema.String;
        attempt: typeof Schema.Number;
        timeoutMs: typeof Schema.Number;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["TaskHeartbeatTimeout"]>;
        message: typeof Schema.String;
        nodeId: typeof Schema.String;
        iteration: typeof Schema.Number;
        attempt: typeof Schema.Number;
        timeoutMs: typeof Schema.Number;
        staleForMs: typeof Schema.Number;
        lastHeartbeatAtMs: typeof Schema.Number;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["RunNotFound"]>;
        message: typeof Schema.String;
        runId: typeof Schema.String;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["InvalidInput"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["DbWriteFailed"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["AgentCliError"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["WorkflowFailed"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
        status: Schema.optional<typeof Schema.Number>;
    }>]>, Schema.Struct<{
        _tag: Schema.Literal<["UnknownWorkerError"]>;
        errorId: typeof Schema.String;
        message: typeof Schema.String;
    }>]>;
}>]>;
export type TaskResult = Schema.Schema.Type<typeof TaskResult>;
export type TaskFailure = Extract<TaskResult, {
    _tag: "Failure";
}>;
export declare const TaskWorkerEntity: Entity.Entity<"TaskWorker", Rpc.Rpc<"execute", Schema.Struct<{
    executionId: typeof Schema.String;
    bridgeKey: typeof Schema.String;
    workflowName: typeof Schema.String;
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    retries: typeof Schema.Number;
    taskKind: Schema.Literal<["agent", "compute", "static"]>;
    dispatchKind: Schema.Literal<["compute", "static", "legacy"]>;
}>, Schema.Union<[Schema.Struct<{
    _tag: Schema.Literal<["Success"]>;
    executionId: typeof Schema.String;
    terminal: typeof Schema.Boolean;
}>, Schema.Struct<{
    _tag: Schema.Literal<["Failure"]>;
    executionId: typeof Schema.String;
    error: Schema.Union<[Schema.Union<[Schema.Struct<{
        _tag: Schema.Literal<["TaskAborted"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
        name: Schema.optional<typeof Schema.String>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["TaskTimeout"]>;
        message: typeof Schema.String;
        nodeId: typeof Schema.String;
        attempt: typeof Schema.Number;
        timeoutMs: typeof Schema.Number;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["TaskHeartbeatTimeout"]>;
        message: typeof Schema.String;
        nodeId: typeof Schema.String;
        iteration: typeof Schema.Number;
        attempt: typeof Schema.Number;
        timeoutMs: typeof Schema.Number;
        staleForMs: typeof Schema.Number;
        lastHeartbeatAtMs: typeof Schema.Number;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["RunNotFound"]>;
        message: typeof Schema.String;
        runId: typeof Schema.String;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["InvalidInput"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["DbWriteFailed"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["AgentCliError"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["WorkflowFailed"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
        status: Schema.optional<typeof Schema.Number>;
    }>]>, Schema.Struct<{
        _tag: Schema.Literal<["UnknownWorkerError"]>;
        errorId: typeof Schema.String;
        message: typeof Schema.String;
    }>]>;
}>]>, typeof Schema.Never, never>>;
export declare function makeWorkerTask(bridgeKey: string, workflowName: string, runId: string, desc: TaskDescriptor, dispatchKind: WorkerDispatchKind): WorkerTask;
export declare function isTaskResultFailure(result: TaskResult): result is TaskFailure;
export declare function isUnknownWorkerError(error: WorkerTaskError): error is UnknownWorkerError;
export {};
