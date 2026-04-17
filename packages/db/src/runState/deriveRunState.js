import { RUN_STATE_HEARTBEAT_STALE_MS } from "./RUN_STATE_HEARTBEAT_STALE_MS.js";

/** @typedef {import("./DeriveRunStateInput.ts").DeriveRunStateInput} DeriveRunStateInput */
/** @typedef {import("./RunStateView.ts").RunStateView} RunStateView */

/**
 * @param {DeriveRunStateInput} input
 * @returns {RunStateView}
 */
export function deriveRunState(input) {
    const {
        run,
        pendingApproval = null,
        pendingTimer = null,
        pendingEvent = null,
        now = Date.now(),
        staleThresholdMs = RUN_STATE_HEARTBEAT_STALE_MS,
    } = input;

    const computedAt = new Date(now).toISOString();
    const base = { runId: run.runId, computedAt };

    switch (run.status) {
        case "finished":
        case "continued":
            return { ...base, state: "succeeded" };
        case "failed":
            return { ...base, state: "failed" };
        case "cancelled":
            return { ...base, state: "cancelled" };
        case "waiting-approval":
            return pendingApproval
                ? {
                      ...base,
                      state: "waiting-approval",
                      blocked: {
                          kind: "approval",
                          nodeId: pendingApproval.nodeId,
                          requestedAt: new Date(
                              pendingApproval.requestedAtMs,
                          ).toISOString(),
                      },
                  }
                : { ...base, state: "waiting-approval" };
        case "waiting-timer":
            return pendingTimer
                ? {
                      ...base,
                      state: "waiting-timer",
                      blocked: {
                          kind: "timer",
                          nodeId: pendingTimer.nodeId,
                          wakeAt: new Date(pendingTimer.firesAtMs).toISOString(),
                      },
                  }
                : { ...base, state: "waiting-timer" };
        case "waiting-event":
            return pendingEvent
                ? {
                      ...base,
                      state: "waiting-event",
                      blocked: {
                          kind: "event",
                          nodeId: pendingEvent.nodeId,
                          correlationKey: pendingEvent.correlationKey,
                      },
                  }
                : { ...base, state: "waiting-event" };
        case "running":
            return classifyRunning(run, now, staleThresholdMs, base);
        default:
            return { ...base, state: "unknown" };
    }
}

/**
 * @param {import("../adapter/RunRow.ts").RunRow} run
 * @param {number} now
 * @param {number} staleThresholdMs
 * @param {{ runId: string; computedAt: string }} base
 * @returns {RunStateView}
 */
function classifyRunning(run, now, staleThresholdMs, base) {
    const heartbeat =
        typeof run.heartbeatAtMs === "number" ? run.heartbeatAtMs : null;
    const startedAt =
        typeof run.startedAtMs === "number" ? run.startedAtMs : null;
    // Fall back to startedAt so a brand-new run with no heartbeat yet
    // isn't reported as stale.
    const lastAlive = Math.max(heartbeat ?? 0, startedAt ?? 0);

    if (lastAlive === 0) {
        return { ...base, state: "unknown" };
    }

    if (now - lastAlive <= staleThresholdMs) {
        return { ...base, state: "running" };
    }

    const lastHeartbeatAt = new Date(lastAlive).toISOString();
    // Without a registered owner, supervisor has nothing to take over.
    const orphaned =
        run.runtimeOwnerId == null || run.runtimeOwnerId.length === 0;
    return {
        ...base,
        state: orphaned ? "orphaned" : "stale",
        unhealthy: { kind: "engine-heartbeat-stale", lastHeartbeatAt },
    };
}
