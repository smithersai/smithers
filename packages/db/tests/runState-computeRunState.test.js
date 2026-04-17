import { describe, expect, test } from "bun:test";
import { computeRunState } from "../src/runState/computeRunState.js";

const NOW = 1_700_000_000_000;

/**
 * @param {Partial<import("../src/adapter/RunRow.ts").RunRow>} overrides
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

/**
 * @param {{
 *   run?: ReturnType<typeof makeRun> | null,
 *   approvals?: any[],
 *   nodes?: any[],
 *   attemptsByKey?: Record<string, any[]>,
 * }} state
 */
function makeAdapter(state = {}) {
    return {
        async getRun(_runId) {
            return state.run ?? null;
        },
        async listPendingApprovals(_runId) {
            return state.approvals ?? [];
        },
        async listNodes(_runId) {
            return state.nodes ?? [];
        },
        async listAttempts(runId, nodeId, iteration) {
            const key = `${runId}|${nodeId}|${iteration}`;
            return state.attemptsByKey?.[key] ?? [];
        },
    };
}

describe("computeRunState", () => {
    test("throws RUN_NOT_FOUND when run missing", async () => {
        const adapter = makeAdapter({ run: null });
        await expect(computeRunState(adapter, "missing")).rejects.toMatchObject({
            code: "RUN_NOT_FOUND",
        });
    });

    test("running run → state running", async () => {
        const adapter = makeAdapter({ run: makeRun() });
        const view = await computeRunState(adapter, "run-1", { now: NOW });
        expect(view.state).toBe("running");
        expect(view.runId).toBe("run-1");
    });

    test("waiting-approval pulls earliest approval", async () => {
        const adapter = makeAdapter({
            run: makeRun({ status: "waiting-approval" }),
            approvals: [
                { nodeId: "later", requestedAtMs: NOW - 100 },
                { nodeId: "earliest", requestedAtMs: NOW - 5_000 },
                { nodeId: "missing-time", requestedAtMs: null },
            ],
        });
        const view = await computeRunState(adapter, "run-1", { now: NOW });
        expect(view.blocked).toEqual({
            kind: "approval",
            nodeId: "earliest",
            requestedAt: new Date(NOW - 5_000).toISOString(),
        });
    });

    test("waiting-timer pulls earliest fires-at from attempt metaJson", async () => {
        const adapter = makeAdapter({
            run: makeRun({ status: "waiting-timer" }),
            nodes: [
                { nodeId: "t-late", iteration: 0, state: "waiting-timer" },
                { nodeId: "t-soon", iteration: 0, state: "waiting-timer" },
                { nodeId: "n-other", iteration: 0, state: "running" },
            ],
            attemptsByKey: {
                "run-1|t-late|0": [
                    {
                        state: "waiting-timer",
                        metaJson: JSON.stringify({
                            timer: { firesAtMs: NOW + 60_000, timerId: "tl" },
                        }),
                    },
                ],
                "run-1|t-soon|0": [
                    {
                        state: "waiting-timer",
                        metaJson: JSON.stringify({
                            timer: { firesAtMs: NOW + 1_000, timerId: "ts" },
                        }),
                    },
                ],
            },
        });
        const view = await computeRunState(adapter, "run-1", { now: NOW });
        expect(view.state).toBe("waiting-timer");
        expect(view.blocked).toEqual({
            kind: "timer",
            nodeId: "t-soon",
            wakeAt: new Date(NOW + 1_000).toISOString(),
        });
    });

    test("waiting-event pulls correlationKey from attempt metaJson", async () => {
        const adapter = makeAdapter({
            run: makeRun({ status: "waiting-event" }),
            nodes: [{ nodeId: "e-1", iteration: 0, state: "waiting-event" }],
            attemptsByKey: {
                "run-1|e-1|0": [
                    {
                        state: "waiting-event",
                        metaJson: JSON.stringify({
                            event: { correlationKey: "order:42" },
                        }),
                    },
                ],
            },
        });
        const view = await computeRunState(adapter, "run-1", { now: NOW });
        expect(view.blocked).toEqual({
            kind: "event",
            nodeId: "e-1",
            correlationKey: "order:42",
        });
    });

    test("golden snapshot shape is stable", async () => {
        const adapter = makeAdapter({ run: makeRun({ status: "finished" }) });
        const view = await computeRunState(adapter, "run-1", { now: NOW });
        expect(view).toEqual({
            runId: "run-1",
            state: "succeeded",
            computedAt: new Date(NOW).toISOString(),
        });
    });

});
