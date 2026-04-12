// @smithers-type-exports-begin
/** @typedef {import("./rpc-schema.ts").ApprovalPayload} ApprovalPayload */
/** @typedef {import("./rpc-schema.ts").ApprovalResult} ApprovalResult */
/** @typedef {import("./rpc-schema.ts").CancelPayload} CancelPayload */
/** @typedef {import("./rpc-schema.ts").CancelResult} CancelResult */
/** @typedef {import("./rpc-schema.ts").GetRunPayload} GetRunPayload */
/** @typedef {import("./rpc-schema.ts").GetRunResult} GetRunResult */
/** @typedef {import("./rpc-schema.ts").ListRunsPayload} ListRunsPayload */
/** @typedef {import("./rpc-schema.ts").RunStatusSchema} RunStatusSchema */
/** @typedef {import("./rpc-schema.ts").RunSummary} RunSummary */
/** @typedef {import("./rpc-schema.ts").SignalPayload} SignalPayload */
/** @typedef {import("./rpc-schema.ts").SignalResult} SignalResult */
// @smithers-type-exports-end

import * as Rpc from "@effect/rpc/Rpc";
import * as RpcGroup from "@effect/rpc/RpcGroup";
import { Schema } from "effect";
export const RunStatusSchema = Schema.Literal("running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled");
export const ApprovalPayloadSchema = Schema.Struct({
    runId: Schema.String,
    nodeId: Schema.String,
    iteration: Schema.optional(Schema.Number),
    note: Schema.optional(Schema.String),
    decidedBy: Schema.optional(Schema.String),
});
export const ApprovalResultSchema = Schema.Struct({
    runId: Schema.String,
    nodeId: Schema.String,
    iteration: Schema.Number,
    approved: Schema.Boolean,
});
export const CancelPayloadSchema = Schema.Struct({
    runId: Schema.String,
});
export const CancelResultSchema = Schema.Struct({
    runId: Schema.String,
    status: Schema.Literal("cancelling", "cancelled"),
});
export const SignalPayloadSchema = Schema.Struct({
    runId: Schema.String,
    signalName: Schema.String,
    data: Schema.optional(Schema.Unknown),
    correlationId: Schema.optional(Schema.String),
    sentBy: Schema.optional(Schema.String),
});
export const SignalResultSchema = Schema.Struct({
    runId: Schema.String,
    signalName: Schema.String,
    delivered: Schema.Boolean,
    status: Schema.Literal("signalled", "ignored"),
});
export const ListRunsPayloadSchema = Schema.Struct({
    limit: Schema.optional(Schema.Number),
    status: Schema.optional(RunStatusSchema),
});
export const RunSummarySchema = Schema.Struct({
    runId: Schema.String,
    parentRunId: Schema.NullOr(Schema.String),
    workflowName: Schema.String,
    workflowPath: Schema.NullOr(Schema.String),
    workflowHash: Schema.NullOr(Schema.String),
    status: RunStatusSchema,
    createdAtMs: Schema.Number,
    startedAtMs: Schema.NullOr(Schema.Number),
    finishedAtMs: Schema.NullOr(Schema.Number),
    heartbeatAtMs: Schema.NullOr(Schema.Number),
    runtimeOwnerId: Schema.NullOr(Schema.String),
    cancelRequestedAtMs: Schema.NullOr(Schema.Number),
    hijackRequestedAtMs: Schema.NullOr(Schema.Number),
    hijackTarget: Schema.NullOr(Schema.String),
    vcsType: Schema.NullOr(Schema.String),
    vcsRoot: Schema.NullOr(Schema.String),
    vcsRevision: Schema.NullOr(Schema.String),
    errorJson: Schema.NullOr(Schema.String),
    configJson: Schema.NullOr(Schema.String),
});
export const GetRunPayloadSchema = Schema.Struct({
    runId: Schema.String,
});
export const GetRunResultSchema = Schema.NullOr(RunSummarySchema);
export const approve = Rpc.make("approve", {
    payload: ApprovalPayloadSchema,
    success: ApprovalResultSchema,
});
export const cancel = Rpc.make("cancel", {
    payload: CancelPayloadSchema,
    success: CancelResultSchema,
});
export const signal = Rpc.make("signal", {
    payload: SignalPayloadSchema,
    success: SignalResultSchema,
});
export const listRuns = Rpc.make("listRuns", {
    payload: ListRunsPayloadSchema,
    success: Schema.Array(RunSummarySchema),
});
export const getRun = Rpc.make("getRun", {
    payload: GetRunPayloadSchema,
    success: GetRunResultSchema,
});
export const SmithersRpcGroup = RpcGroup.make(approve, cancel, signal, listRuns, getRun);
