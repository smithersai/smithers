import { describe, expect, test } from "bun:test";
import { deriveRunState } from "../src/runState/deriveRunState.js";
import { RUN_STATE_HEARTBEAT_STALE_MS } from "../src/runState/RUN_STATE_HEARTBEAT_STALE_MS.js";

const NOW = 1_700_000_000_000;

/**
 * @param {Partial<import("../src/adapter/RunRow.ts").RunRow>} overrides
 * @returns {import("../src/adapter/RunRow.ts").RunRow}
 */
function makeRun(overrides = {}) {
    return {
        runId: "run-1",
        parentRunId: null,
        workflowName: "wf",
        workflowPath: null,
        workflowHash: null,
        status: "running",
        createdAtMs: NOW - 60_000,
        startedAtMs: NOW - 60_000,
        finishedAtMs: null,
        heartbeatAtMs: NOW,
        runtimeOwnerId: "host:1234",
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        vcsType: null,
        vcsRoot: null,
        vcsRevision: null,
        errorJson: null,
        configJson: null,
        ...overrides,
    };
}

describe("deriveRunState — terminal states", () => {
    test("finished maps to succeeded", () => {
        const view = deriveRunState({
            run: makeRun({ status: "finished" }),
            now: NOW,
        });
        expect(view).toEqual({
            runId: "run-1",
            state: "succeeded",
            computedAt: new Date(NOW).toISOString(),
        });
    });

    test("continued maps to succeeded", () => {
        const view = deriveRunState({
            run: makeRun({ status: "continued" }),
            now: NOW,
        });
        expect(view.state).toBe("succeeded");
    });

    test("failed maps to failed", () => {
        const view = deriveRunState({
            run: makeRun({ status: "failed" }),
            now: NOW,
        });
        expect(view.state).toBe("failed");
        expect(view.unhealthy).toBeUndefined();
        expect(view.blocked).toBeUndefined();
    });

    test("cancelled maps to cancelled", () => {
        const view = deriveRunState({
            run: makeRun({ status: "cancelled" }),
            now: NOW,
        });
        expect(view.state).toBe("cancelled");
    });
});

describe("deriveRunState — running / stale / orphaned", () => {
    test("fresh heartbeat → running", () => {
        const view = deriveRunState({
            run: makeRun({ heartbeatAtMs: NOW - 5_000 }),
            now: NOW,
        });
        expect(view.state).toBe("running");
        expect(view.unhealthy).toBeUndefined();
    });

    test("heartbeat older than threshold + owner present → stale", () => {
        const stale = NOW - (RUN_STATE_HEARTBEAT_STALE_MS + 5_000);
        const view = deriveRunState({
            run: makeRun({ heartbeatAtMs: stale }),
            now: NOW,
        });
        expect(view.state).toBe("stale");
        expect(view.unhealthy).toEqual({
            kind: "engine-heartbeat-stale",
            lastHeartbeatAt: new Date(stale).toISOString(),
        });
    });

    test("heartbeat stale + no owner → orphaned", () => {
        const stale = NOW - (RUN_STATE_HEARTBEAT_STALE_MS + 5_000);
        const view = deriveRunState({
            run: makeRun({ heartbeatAtMs: stale, runtimeOwnerId: null }),
            now: NOW,
        });
        expect(view.state).toBe("orphaned");
        expect(view.unhealthy?.kind).toBe("engine-heartbeat-stale");
    });

    test("running with no heartbeat but recent startedAt → running", () => {
        const view = deriveRunState({
            run: makeRun({ heartbeatAtMs: null, startedAtMs: NOW - 1_000 }),
            now: NOW,
        });
        expect(view.state).toBe("running");
    });

    test("running with no signals at all → unknown (never invent succeeded)", () => {
        const view = deriveRunState({
            run: makeRun({ heartbeatAtMs: null, startedAtMs: null }),
            now: NOW,
        });
        expect(view.state).toBe("unknown");
    });

    test("custom staleThresholdMs is honored", () => {
        const view = deriveRunState({
            run: makeRun({ heartbeatAtMs: NOW - 10_000 }),
            now: NOW,
            staleThresholdMs: 5_000,
        });
        expect(view.state).toBe("stale");
    });
});

describe("deriveRunState — waiting states", () => {
    test("waiting-approval without context → state only", () => {
        const view = deriveRunState({
            run: makeRun({ status: "waiting-approval" }),
            now: NOW,
        });
        expect(view.state).toBe("waiting-approval");
        expect(view.blocked).toBeUndefined();
    });

    test("waiting-approval with pendingApproval → blocked.approval", () => {
        const view = deriveRunState({
            run: makeRun({ status: "waiting-approval" }),
            pendingApproval: { nodeId: "n-1", requestedAtMs: NOW - 1_000 },
            now: NOW,
        });
        expect(view.blocked).toEqual({
            kind: "approval",
            nodeId: "n-1",
            requestedAt: new Date(NOW - 1_000).toISOString(),
        });
    });

    test("waiting-timer with pendingTimer → blocked.timer", () => {
        const view = deriveRunState({
            run: makeRun({ status: "waiting-timer" }),
            pendingTimer: { nodeId: "t-1", firesAtMs: NOW + 60_000 },
            now: NOW,
        });
        expect(view.state).toBe("waiting-timer");
        expect(view.blocked).toEqual({
            kind: "timer",
            nodeId: "t-1",
            wakeAt: new Date(NOW + 60_000).toISOString(),
        });
    });

    test("waiting-event with pendingEvent → blocked.event", () => {
        const view = deriveRunState({
            run: makeRun({ status: "waiting-event" }),
            pendingEvent: { nodeId: "e-1", correlationKey: "order:42" },
            now: NOW,
        });
        expect(view.state).toBe("waiting-event");
        expect(view.blocked).toEqual({
            kind: "event",
            nodeId: "e-1",
            correlationKey: "order:42",
        });
    });
});

describe("deriveRunState — fallbacks", () => {
    test("unrecognized status → unknown (never idle, never succeeded)", () => {
        const view = deriveRunState({
            run: makeRun({ status: "idle" }),
            now: NOW,
        });
        expect(view.state).toBe("unknown");
    });

    test("empty status → unknown", () => {
        const view = deriveRunState({
            run: makeRun({ status: "" }),
            now: NOW,
        });
        expect(view.state).toBe("unknown");
    });

    test("computedAt is ISO-8601 of now", () => {
        const view = deriveRunState({
            run: makeRun({ status: "finished" }),
            now: NOW,
        });
        expect(view.computedAt).toBe(new Date(NOW).toISOString());
    });

    test("never emits 'idle' — golden state list", () => {
        const states = [
            "running",
            "waiting-approval",
            "waiting-event",
            "waiting-timer",
            "recovering",
            "stale",
            "orphaned",
            "failed",
            "cancelled",
            "succeeded",
            "unknown",
        ];
        // sanity: every emittable state from deriveRunState appears in the
        // documented list, and "idle" never does.
        const emitted = new Set();
        for (const status of [
            "running",
            "waiting-approval",
            "waiting-timer",
            "waiting-event",
            "finished",
            "continued",
            "failed",
            "cancelled",
            "garbage",
        ]) {
            emitted.add(deriveRunState({ run: makeRun({ status }), now: NOW }).state);
        }
        emitted.add(
            deriveRunState({
                run: makeRun({
                    heartbeatAtMs: NOW - (RUN_STATE_HEARTBEAT_STALE_MS + 5_000),
                }),
                now: NOW,
            }).state,
        );
        emitted.add(
            deriveRunState({
                run: makeRun({
                    heartbeatAtMs: NOW - (RUN_STATE_HEARTBEAT_STALE_MS + 5_000),
                    runtimeOwnerId: null,
                }),
                now: NOW,
            }).state,
        );
        for (const s of emitted) expect(states).toContain(s);
        expect(emitted.has("idle")).toBe(false);
    });
});
