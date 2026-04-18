import { Effect, Metric } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { approvalWaitDuration, trackEvent, updateAsyncExternalWaitPending, } from "@smithers-orchestrator/observability/metrics";
import { bridgeApprovalResolve } from "./effect/durable-deferred-bridge.js";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/**
 * @param {string | null | undefined} currentStatus
 * @param {number} pendingApprovals
 * @returns {"waiting-approval" | "waiting-event" | null}
 */
function nextRunStatusForApproval(currentStatus, pendingApprovals) {
    if (currentStatus !== "waiting-approval" &&
        currentStatus !== "waiting-event") {
        return null;
    }
    return pendingApprovals > 0 ? "waiting-approval" : "waiting-event";
}
/**
 * @param {unknown} decision
 */
function serializeDecision(decision) {
    return decision === undefined ? null : JSON.stringify(decision);
}
/**
 * @param {string | null} [requestJson]
 */
function isAsyncApprovalRequest(requestJson) {
    if (!requestJson)
        return false;
    try {
        return JSON.parse(requestJson)?.waitAsync === true;
    }
    catch {
        return false;
    }
}
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string | null | undefined} state
 * @returns {Effect.Effect<void, SmithersError>}
 */
function validateNodeWaitingForApproval(runId, nodeId, iteration, state) {
    if (state === "waiting-approval" || state === "waiting_approval") {
        return Effect.void;
    }
    return Effect.fail(new SmithersError("INVALID_INPUT", `Node ${nodeId} is not waiting for approval.`, { runId, nodeId, iteration, state: state ?? null }));
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string} [note]
 * @param {string} [decidedBy]
 * @param {unknown} [decision]
 * @param {boolean} [autoApproved]
 * @returns {Effect.Effect<void, SmithersError, never>}
 */
export function approveNode(adapter, runId, nodeId, iteration, note, decidedBy, decision, autoApproved = false) {
    const ts = nowMs();
    const event = {
        type: autoApproved ? "ApprovalAutoApproved" : "ApprovalGranted",
        runId,
        nodeId,
        iteration,
        timestampMs: ts,
    };
    return Effect.gen(function* () {
        const existing = yield* adapter.getApproval(runId, nodeId, iteration);
        const currentNode = yield* adapter.getNode(runId, nodeId, iteration);
        yield* validateNodeWaitingForApproval(runId, nodeId, iteration, currentNode?.state);
        yield* adapter.withTransactionEffect("approval", Effect.gen(function* () {
            yield* adapter.insertOrUpdateApproval({
                runId,
                nodeId,
                iteration,
                status: "approved",
                requestedAtMs: null,
                decidedAtMs: ts,
                note: note ?? null,
                decidedBy: decidedBy ?? null,
                requestJson: existing?.requestJson ?? null,
                decisionJson: serializeDecision(decision) ?? existing?.decisionJson ?? null,
                autoApproved,
            });
            yield* adapter.insertNode({
                runId,
                nodeId,
                iteration,
                state: "pending",
                lastAttempt: currentNode?.lastAttempt ?? null,
                updatedAtMs: nowMs(),
                outputTable: currentNode?.outputTable ?? "",
                label: currentNode?.label ?? null,
            });
            const run = yield* adapter.getRun(runId);
            if (run) {
                const pending = yield* adapter.listPendingApprovals(runId);
                const nextStatus = nextRunStatusForApproval(run.status, pending.length);
                if (nextStatus && run.status !== nextStatus) {
                    yield* adapter.updateRun(runId, { status: nextStatus });
                }
            }
        }));
        if (existing?.requestedAtMs) {
            yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
        }
        if (existing?.status === "requested" && isAsyncApprovalRequest(existing.requestJson)) {
            yield* updateAsyncExternalWaitPending("approval", -1);
        }
        yield* adapter.insertEventWithNextSeq({
            runId,
            timestampMs: ts,
            type: event.type,
            payloadJson: JSON.stringify(event),
        });
        yield* trackEvent(event);
        yield* Effect.logInfo(autoApproved ? "approval auto-approved" : "approval granted");
        yield* Effect.promise(() => bridgeApprovalResolve(adapter, runId, nodeId, iteration, {
            approved: true,
            note: note ?? null,
            decidedBy: decidedBy ?? null,
            decisionJson: serializeDecision(decision),
            autoApproved,
        }));
    }).pipe(Effect.annotateLogs({
        runId,
        nodeId,
        iteration,
        approvalStatus: autoApproved ? "auto-approved" : "approved",
        approvalDecidedBy: decidedBy ?? null,
    }), Effect.withLogSpan("approval:grant"));
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string} [note]
 * @param {string} [decidedBy]
 * @param {unknown} [decision]
 * @returns {Effect.Effect<void, SmithersError, never>}
 */
export function denyNode(adapter, runId, nodeId, iteration, note, decidedBy, decision) {
    const ts = nowMs();
    const event = {
        type: "ApprovalDenied",
        runId,
        nodeId,
        iteration,
        timestampMs: ts,
    };
    return Effect.gen(function* () {
        const existing = yield* adapter.getApproval(runId, nodeId, iteration);
        const currentNode = yield* adapter.getNode(runId, nodeId, iteration);
        yield* validateNodeWaitingForApproval(runId, nodeId, iteration, currentNode?.state);
        yield* adapter.withTransactionEffect("approval", Effect.gen(function* () {
            yield* adapter.insertOrUpdateApproval({
                runId,
                nodeId,
                iteration,
                status: "denied",
                requestedAtMs: null,
                decidedAtMs: ts,
                note: note ?? null,
                decidedBy: decidedBy ?? null,
                requestJson: existing?.requestJson ?? null,
                decisionJson: serializeDecision(decision) ?? existing?.decisionJson ?? null,
                autoApproved: false,
            });
            yield* adapter.insertNode({
                runId,
                nodeId,
                iteration,
                state: "failed",
                lastAttempt: currentNode?.lastAttempt ?? null,
                updatedAtMs: nowMs(),
                outputTable: currentNode?.outputTable ?? "",
                label: currentNode?.label ?? null,
            });
            const run = yield* adapter.getRun(runId);
            if (run) {
                const pending = yield* adapter.listPendingApprovals(runId);
                const nextStatus = nextRunStatusForApproval(run.status, pending.length);
                if (nextStatus && run.status !== nextStatus) {
                    yield* adapter.updateRun(runId, { status: nextStatus });
                }
            }
        }));
        if (existing?.requestedAtMs) {
            yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
        }
        if (existing?.status === "requested" && isAsyncApprovalRequest(existing.requestJson)) {
            yield* updateAsyncExternalWaitPending("approval", -1);
        }
        yield* adapter.insertEventWithNextSeq({
            runId,
            timestampMs: ts,
            type: "ApprovalDenied",
            payloadJson: JSON.stringify(event),
        });
        yield* trackEvent(event);
        yield* Effect.logInfo("approval denied");
        yield* Effect.promise(() => bridgeApprovalResolve(adapter, runId, nodeId, iteration, {
            approved: false,
            note: note ?? null,
            decidedBy: decidedBy ?? null,
            decisionJson: serializeDecision(decision),
        }));
    }).pipe(Effect.annotateLogs({
        runId,
        nodeId,
        iteration,
        approvalStatus: "denied",
        approvalDecidedBy: decidedBy ?? null,
    }), Effect.withLogSpan("approval:deny"));
}
