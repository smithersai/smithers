// @smithers-type-exports-begin
/** @typedef {import("./ApprovalDurableDeferredResolution.ts").ApprovalDurableDeferredResolution} ApprovalDurableDeferredResolution */
/** @typedef {import("./WaitForEventDurableDeferredResolution.ts").WaitForEventDurableDeferredResolution} WaitForEventDurableDeferredResolution */
// @smithers-type-exports-end

import * as DurableDeferred from "@effect/workflow/DurableDeferred";
import * as Workflow from "@effect/workflow/Workflow";
import { resolve as resolvePath } from "node:path";
import { Effect, Exit, Schema } from "effect";
import { updateAsyncExternalWaitPending } from "@smithers-orchestrator/observability/metrics";
/**
 * @typedef {{ _tag: "Complete"; exit: Exit.Exit<any, any>; } | { _tag: "Pending"; }} BridgeDeferredResult
 */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} _SmithersDb */
/**
 * @typedef {{ signalName: string; correlationId: string | null; payloadJson: string; seq: number; receivedAtMs: number; }} WaitForEventSignalInput
 */

export const DurableDeferredBridgeWorkflow = Workflow.make({
    name: "SmithersDurableDeferredBridge",
    payload: { executionId: Schema.String },
    success: Schema.Unknown,
    idempotencyKey: ({ executionId }) => executionId,
});
const adapterNamespaces = new WeakMap();
let nextAdapterNamespace = 0;
/**
 * @param {_SmithersDb} adapter
 * @returns {string}
 */
const getAdapterNamespace = (adapter) => {
    const filename = adapter?.db?.$client?.filename;
    if (typeof filename === "string" && filename.length > 0 && filename !== ":memory:") {
        return `sqlite:${resolvePath(filename)}`;
    }
    const existing = adapterNamespaces.get(adapter);
    if (existing) {
        return existing;
    }
    const created = `adapter-${++nextAdapterNamespace}`;
    adapterNamespaces.set(adapter, created);
    return created;
};
export const approvalDurableDeferredSuccessSchema = Schema.Struct({
    approved: Schema.Boolean,
    note: Schema.NullOr(Schema.String),
    decidedBy: Schema.NullOr(Schema.String),
    decisionJson: Schema.NullOr(Schema.String),
    autoApproved: Schema.Boolean,
});
export const waitForEventDurableDeferredSuccessSchema = Schema.Struct({
    signalName: Schema.String,
    correlationId: Schema.NullOr(Schema.String),
    payloadJson: Schema.String,
    seq: Schema.Number,
    receivedAtMs: Schema.Number,
});
/**
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function normalizeCorrelationId(value) {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized.length > 0 ? normalized : null;
}
/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function parseOptionalFiniteNumber(value) {
    if (value == null || value === "") {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/**
 * @param {string | null} [metaJson]
 * @returns {WaitForEventAttemptSnapshot | null}
 */
function parseWaitForEventAttemptSnapshot(metaJson) {
    if (!metaJson)
        return null;
    try {
        const parsed = JSON.parse(metaJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        const waitForEvent = parsed?.waitForEvent;
        if (!waitForEvent || typeof waitForEvent !== "object" || Array.isArray(waitForEvent)) {
            return null;
        }
        const signalName = typeof waitForEvent.signalName === "string"
            ? waitForEvent.signalName.trim()
            : "";
        if (!signalName) {
            return null;
        }
        return {
            meta: parsed,
            signalName,
            correlationId: normalizeCorrelationId(waitForEvent.correlationId),
            waitAsync: waitForEvent.waitAsync === true,
            resolvedSignalSeq: parseOptionalFiniteNumber(waitForEvent.resolvedSignalSeq),
            receivedAtMs: parseOptionalFiniteNumber(waitForEvent.receivedAtMs),
        };
    }
    catch {
        return null;
    }
}
/**
 * @param {WaitForEventAttemptSnapshot} snapshot
 * @param {WaitForEventSignalInput} signal
 * @returns {string}
 */
function buildResolvedWaitForEventMetaJson(snapshot, signal) {
    const waitForEvent = snapshot.meta.waitForEvent &&
        typeof snapshot.meta.waitForEvent === "object" &&
        !Array.isArray(snapshot.meta.waitForEvent)
        ? snapshot.meta.waitForEvent
        : {};
    return JSON.stringify({
        ...snapshot.meta,
        kind: typeof snapshot.meta.kind === "string"
            ? snapshot.meta.kind
            : "wait-for-event",
        waitForEvent: {
            ...waitForEvent,
            signalName: snapshot.signalName,
            correlationId: snapshot.correlationId,
            waitAsync: snapshot.waitAsync,
            resolvedSignalSeq: signal.seq,
            receivedAtMs: signal.receivedAtMs,
        },
    });
}
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {WaitForEventSignalInput} signal
 */
async function markWaitForEventResolved(adapter, runId, nodeId, iteration, signal) {
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, nodeId, iteration));
    const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-event") ??
        attempts[0];
    const snapshot = parseWaitForEventAttemptSnapshot(waitingAttempt?.metaJson);
    if (!waitingAttempt || !snapshot || snapshot.resolvedSignalSeq !== undefined) {
        return;
    }
    await Effect.runPromise(adapter.updateAttempt(runId, nodeId, iteration, waitingAttempt.attempt, {
        metaJson: buildResolvedWaitForEventMetaJson(snapshot, signal),
    }));
    if (snapshot.waitAsync) {
        try {
            await Effect.runPromise(updateAsyncExternalWaitPending("event", -1));
        }
        catch { }
    }
}
const deferredResolutions = new Map();
/**
 * @template Success, Error
 * @param {string} executionId
 * @param {DurableDeferred.DurableDeferred<Success, Error>} _deferred
 * @returns {Promise<BridgeDeferredResult>}
 */
const awaitBridgeDeferred = async (executionId, _deferred) => {
    const exit = deferredResolutions.get(executionId);
    return exit ? { _tag: "Complete", exit } : { _tag: "Pending" };
};
/**
 * @template Success, Error
 * @param {string} executionId
 * @param {DurableDeferred.DurableDeferred<Success, Error>} _deferred
 * @param {Exit.Exit<Success["Type"], Error["Type"]>} exit
 */
const resolveBridgeDeferred = async (executionId, _deferred, exit) => {
    deferredResolutions.set(executionId, exit);
};
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
export const makeDurableDeferredBridgeExecutionId = (adapter, runId, nodeId, iteration) => [
    "smithers-durable-deferred-bridge",
    getAdapterNamespace(adapter),
    runId,
    nodeId,
    String(iteration),
].join(":");
/**
 * @param {string} nodeId
 */
export const makeApprovalDurableDeferred = (nodeId) => DurableDeferred.make(`approval:${nodeId}`, {
    success: approvalDurableDeferredSuccessSchema,
});
/**
 * @param {string} nodeId
 */
export const makeWaitForEventDurableDeferred = (nodeId) => DurableDeferred.make(`wait-for-event:${nodeId}`, {
    success: waitForEventDurableDeferredSuccessSchema,
});
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 */
export const awaitApprovalDurableDeferred = (adapter, runId, nodeId, iteration) => awaitBridgeDeferred(makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration), makeApprovalDurableDeferred(nodeId));
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 */
export const awaitWaitForEventDurableDeferred = (adapter, runId, nodeId, iteration) => awaitBridgeDeferred(makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration), makeWaitForEventDurableDeferred(nodeId));
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {{ approved: boolean; note?: string | null; decidedBy?: string | null; decisionJson?: string | null; autoApproved?: boolean; }} resolution
 */
export const bridgeApprovalResolve = async (adapter, runId, nodeId, iteration, resolution) => {
    await resolveBridgeDeferred(makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration), makeApprovalDurableDeferred(nodeId), Exit.succeed({
        approved: resolution.approved,
        note: resolution.note ?? null,
        decidedBy: resolution.decidedBy ?? null,
        decisionJson: resolution.decisionJson ?? null,
        autoApproved: resolution.autoApproved ?? false,
    }));
};
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {WaitForEventSignalInput} signal
 */
export const bridgeWaitForEventResolve = async (adapter, runId, nodeId, iteration, signal) => {
    await markWaitForEventResolved(adapter, runId, nodeId, iteration, signal);
    await resolveBridgeDeferred(makeDurableDeferredBridgeExecutionId(adapter, runId, nodeId, iteration), makeWaitForEventDurableDeferred(nodeId), Exit.succeed({
        signalName: signal.signalName,
        correlationId: normalizeCorrelationId(signal.correlationId),
        payloadJson: signal.payloadJson,
        seq: signal.seq,
        receivedAtMs: signal.receivedAtMs,
    }));
};
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {WaitForEventSignalInput} signal
 */
export const bridgeSignalResolve = async (adapter, runId, signal) => {
    const nodes = await Effect.runPromise(adapter.listNodes(runId));
    const normalizedCorrelationId = normalizeCorrelationId(signal.correlationId);
    for (const node of nodes) {
        if (node.state !== "waiting-event")
            continue;
        const iteration = node.iteration ?? 0;
        const attempts = await Effect.runPromise(adapter.listAttempts(runId, node.nodeId, iteration));
        const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-event") ??
            attempts[0];
        if (!waitingAttempt)
            continue;
        const snapshot = parseWaitForEventAttemptSnapshot(waitingAttempt.metaJson);
        if (!snapshot)
            continue;
        if (snapshot.signalName !== signal.signalName)
            continue;
        if (snapshot.correlationId !== normalizedCorrelationId)
            continue;
        await bridgeWaitForEventResolve(adapter, runId, node.nodeId, iteration, signal);
    }
};
