// @smithers-type-exports-begin
/** @typedef {import("./ApprovalDeferredResolution.ts").ApprovalDeferredResolution} ApprovalDeferredResolution */
/** @typedef {import("./DeferredResolution.ts").DeferredResolution} DeferredResolution */
// @smithers-type-exports-end

import * as DurableDeferred from "@effect/workflow/DurableDeferred";
import * as Workflow from "@effect/workflow/Workflow";
import { Exit, Schema } from "effect";
export const DeferredBridgeWorkflow = Workflow.make({
    name: "SmithersDeferredBridge",
    payload: { executionId: Schema.String },
    success: Schema.Unknown,
    idempotencyKey: ({ executionId }) => executionId,
});
const approvalDeferredSuccessSchema = Schema.Struct({
    approved: Schema.Boolean,
    note: Schema.NullOr(Schema.String),
    decidedBy: Schema.NullOr(Schema.String),
});
const deferredResolutions = new Map();
/**
 * @param {string} nodeId
 */
export const makeApprovalDeferred = (nodeId) => DurableDeferred.make(nodeId, { success: approvalDeferredSuccessSchema });
/**
 * @param {string} nodeId
 */
export const makeTimerDeferred = (nodeId) => DurableDeferred.make(nodeId);
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
export const makeDeferredBridgeKey = (runId, nodeId, iteration) => ["smithers-deferred-bridge", runId, nodeId, String(iteration)].join(":");
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {{ approved: boolean }} decision
 */
export const bridgeApprovalResolve = (runId, nodeId, iteration, decision) => {
    deferredResolutions.set(makeDeferredBridgeKey(runId, nodeId, iteration), Exit.succeed({
        approved: decision.approved,
        note: null,
        decidedBy: null,
    }));
};
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 */
export const bridgeTimerResolve = (runId, nodeId, iteration) => {
    deferredResolutions.set(makeDeferredBridgeKey(runId, nodeId, iteration), Exit.void);
};
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {DeferredResolution | undefined}
 */
export const getDeferredResolution = (runId, nodeId, iteration) => deferredResolutions.get(makeDeferredBridgeKey(runId, nodeId, iteration));
