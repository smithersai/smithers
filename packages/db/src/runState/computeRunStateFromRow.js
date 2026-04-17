import { deriveRunState } from "./deriveRunState.js";
import { parseEventMeta } from "./parseEventMeta.js";
import { parseTimerMeta } from "./parseTimerMeta.js";

/** @typedef {import("../adapter/RunRow.ts").RunRow} RunRow */
/** @typedef {import("../adapter/SmithersDb.js").SmithersDb} SmithersDb */
/** @typedef {import("./RunStateView.ts").RunStateView} RunStateView */
/** @typedef {import("./ComputeRunStateOptions.ts").ComputeRunStateOptions} ComputeRunStateOptions */

/**
 * @param {SmithersDb} adapter
 * @param {RunRow} run
 * @param {ComputeRunStateOptions} [options]
 * @returns {Promise<RunStateView>}
 */
export async function computeRunStateFromRow(adapter, run, options = {}) {
    let pendingApproval = null;
    let pendingTimer = null;
    let pendingEvent = null;

    if (run.status === "waiting-approval") {
        pendingApproval = await loadPendingApproval(adapter, run.runId);
    } else if (run.status === "waiting-timer") {
        pendingTimer = await loadPendingTimer(adapter, run.runId);
    } else if (run.status === "waiting-event") {
        pendingEvent = await loadPendingEvent(adapter, run.runId);
    }

    return deriveRunState({
        run,
        pendingApproval,
        pendingTimer,
        pendingEvent,
        now: options.now,
        staleThresholdMs: options.staleThresholdMs,
    });
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function loadPendingApproval(adapter, runId) {
    const approvals = await adapter.listPendingApprovals(runId);
    let earliest = null;
    for (const a of approvals) {
        if (typeof a.requestedAtMs !== "number") continue;
        if (earliest == null || a.requestedAtMs < earliest.requestedAtMs) {
            earliest = { nodeId: a.nodeId, requestedAtMs: a.requestedAtMs };
        }
    }
    return earliest;
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function loadPendingTimer(adapter, runId) {
    const nodes = await adapter.listNodes(runId);
    let earliest = null;
    for (const node of nodes) {
        if (node.state !== "waiting-timer") continue;
        const attempts = await adapter.listAttempts(
            runId,
            node.nodeId,
            node.iteration ?? 0,
        );
        const waiting =
            attempts.find((a) => a.state === "waiting-timer") ?? attempts[0];
        const parsed = parseTimerMeta(waiting?.metaJson);
        if (parsed == null) continue;
        if (earliest == null || parsed.firesAtMs < earliest.firesAtMs) {
            earliest = { nodeId: node.nodeId, firesAtMs: parsed.firesAtMs };
        }
    }
    return earliest;
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function loadPendingEvent(adapter, runId) {
    const nodes = await adapter.listNodes(runId);
    for (const node of nodes) {
        if (node.state !== "waiting-event") continue;
        const attempts = await adapter.listAttempts(
            runId,
            node.nodeId,
            node.iteration ?? 0,
        );
        const waiting =
            attempts.find((a) => a.state === "waiting-event") ?? attempts[0];
        const parsed = parseEventMeta(waiting?.metaJson);
        return {
            nodeId: node.nodeId,
            correlationKey: parsed?.correlationKey ?? "",
        };
    }
    return null;
}
