import * as Rpc from "@effect/rpc/Rpc";
import * as RpcGroup from "@effect/rpc/RpcGroup";
import { Schema } from "effect";
export declare const RunStatusSchema: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
export type RunStatusSchema = Schema.Schema.Type<typeof RunStatusSchema>;
export declare const ApprovalPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: Schema.optional<typeof Schema.Number>;
    note: Schema.optional<typeof Schema.String>;
    decidedBy: Schema.optional<typeof Schema.String>;
}>;
export type ApprovalPayload = Schema.Schema.Type<typeof ApprovalPayloadSchema>;
export declare const ApprovalResultSchema: Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    approved: typeof Schema.Boolean;
}>;
export type ApprovalResult = Schema.Schema.Type<typeof ApprovalResultSchema>;
export declare const CancelPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
}>;
export type CancelPayload = Schema.Schema.Type<typeof CancelPayloadSchema>;
export declare const CancelResultSchema: Schema.Struct<{
    runId: typeof Schema.String;
    status: Schema.Literal<["cancelling", "cancelled"]>;
}>;
export type CancelResult = Schema.Schema.Type<typeof CancelResultSchema>;
export declare const SignalPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    data: Schema.optional<typeof Schema.Unknown>;
    correlationId: Schema.optional<typeof Schema.String>;
    sentBy: Schema.optional<typeof Schema.String>;
}>;
export type SignalPayload = Schema.Schema.Type<typeof SignalPayloadSchema>;
export declare const SignalResultSchema: Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    delivered: typeof Schema.Boolean;
    status: Schema.Literal<["signalled", "ignored"]>;
}>;
export type SignalResult = Schema.Schema.Type<typeof SignalResultSchema>;
export declare const ListRunsPayloadSchema: Schema.Struct<{
    limit: Schema.optional<typeof Schema.Number>;
    status: Schema.optional<Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>>;
}>;
export type ListRunsPayload = Schema.Schema.Type<typeof ListRunsPayloadSchema>;
export declare const RunSummarySchema: Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>;
export type RunSummary = Schema.Schema.Type<typeof RunSummarySchema>;
export declare const GetRunPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
}>;
export type GetRunPayload = Schema.Schema.Type<typeof GetRunPayloadSchema>;
export declare const GetRunResultSchema: Schema.NullOr<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>;
export type GetRunResult = Schema.Schema.Type<typeof GetRunResultSchema>;
export declare const approve: Rpc.Rpc<"approve", Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: Schema.optional<typeof Schema.Number>;
    note: Schema.optional<typeof Schema.String>;
    decidedBy: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    approved: typeof Schema.Boolean;
}>, typeof Schema.Never, never>;
export declare const cancel: Rpc.Rpc<"cancel", Schema.Struct<{
    runId: typeof Schema.String;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    status: Schema.Literal<["cancelling", "cancelled"]>;
}>, typeof Schema.Never, never>;
export declare const signal: Rpc.Rpc<"signal", Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    data: Schema.optional<typeof Schema.Unknown>;
    correlationId: Schema.optional<typeof Schema.String>;
    sentBy: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    delivered: typeof Schema.Boolean;
    status: Schema.Literal<["signalled", "ignored"]>;
}>, typeof Schema.Never, never>;
export declare const listRuns: Rpc.Rpc<"listRuns", Schema.Struct<{
    limit: Schema.optional<typeof Schema.Number>;
    status: Schema.optional<Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>>;
}>, Schema.Array$<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>, typeof Schema.Never, never>;
export declare const getRun: Rpc.Rpc<"getRun", Schema.Struct<{
    runId: typeof Schema.String;
}>, Schema.NullOr<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>, typeof Schema.Never, never>;
export declare const SmithersRpcGroup: RpcGroup.RpcGroup<Rpc.Rpc<"approve", Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: Schema.optional<typeof Schema.Number>;
    note: Schema.optional<typeof Schema.String>;
    decidedBy: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    approved: typeof Schema.Boolean;
}>, typeof Schema.Never, never> | Rpc.Rpc<"cancel", Schema.Struct<{
    runId: typeof Schema.String;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    status: Schema.Literal<["cancelling", "cancelled"]>;
}>, typeof Schema.Never, never> | Rpc.Rpc<"signal", Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    data: Schema.optional<typeof Schema.Unknown>;
    correlationId: Schema.optional<typeof Schema.String>;
    sentBy: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    delivered: typeof Schema.Boolean;
    status: Schema.Literal<["signalled", "ignored"]>;
}>, typeof Schema.Never, never> | Rpc.Rpc<"listRuns", Schema.Struct<{
    limit: Schema.optional<typeof Schema.Number>;
    status: Schema.optional<Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>>;
}>, Schema.Array$<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>, typeof Schema.Never, never> | Rpc.Rpc<"getRun", Schema.Struct<{
    runId: typeof Schema.String;
}>, Schema.NullOr<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>, typeof Schema.Never, never>>;
