import { describe, expect, test } from "bun:test";
import { computeRunState } from "../src/runState/computeRunState.js";

const NOW = 1_700_000_000_000;

describe("RunStateView wire-contract", () => {
    test("computeRunState returns the documented field set", async () => {
        const adapter = makeAdapter({
            run: {
                runId: "r-1",
                parentRunId: null,
                workflowName: "wf",
                workflowPath: null,
                workflowHash: null,
                status: "finished",
                createdAtMs: NOW - 60_000,
                startedAtMs: NOW - 60_000,
                finishedAtMs: NOW - 1_000,
                heartbeatAtMs: NOW - 1_000,
                runtimeOwnerId: "host:1",
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                vcsType: null,
                vcsRoot: null,
                vcsRevision: null,
                errorJson: null,
                configJson: null,
            },
        });
        const view = await computeRunState(adapter, "r-1", { now: NOW });
        const keys = Object.keys(view).sort();
        // Terminal-state shape: just runId / state / computedAt.
        expect(keys).toEqual(["computedAt", "runId", "state"]);
        expect(view.state).toBe("succeeded");
    });

    test("byte-identical JSON across simulated CLI / Gateway / DevTools surfaces", async () => {
        const adapter = makeAdapter({
            run: {
                runId: "r-2",
                parentRunId: null,
                workflowName: "wf",
                workflowPath: null,
                workflowHash: null,
                status: "waiting-approval",
                createdAtMs: NOW - 60_000,
                startedAtMs: NOW - 60_000,
                finishedAtMs: null,
                heartbeatAtMs: NOW,
                runtimeOwnerId: "host:1",
                cancelRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                vcsType: null,
                vcsRoot: null,
                vcsRevision: null,
                errorJson: null,
                configJson: null,
            },
            approvals: [{ nodeId: "n-approve", requestedAtMs: NOW - 5_000 }],
        });

        // Each surface calls computeRunState and embeds the value verbatim.
        const inspectShape = {
            ...{ runState: await computeRunState(adapter, "r-2", { now: NOW }) },
        };
        const gatewayShape = {
            runState: await computeRunState(adapter, "r-2", { now: NOW }),
        };
        const devtoolsShape = {
            runState: await computeRunState(adapter, "r-2", { now: NOW }),
        };

        const a = JSON.stringify(inspectShape.runState);
        const b = JSON.stringify(gatewayShape.runState);
        const c = JSON.stringify(devtoolsShape.runState);
        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(JSON.parse(a)).toEqual({
            runId: "r-2",
            state: "waiting-approval",
            blocked: {
                kind: "approval",
                nodeId: "n-approve",
                requestedAt: new Date(NOW - 5_000).toISOString(),
            },
            computedAt: new Date(NOW).toISOString(),
        });
    });
});

/**
 * @param {{
 *   run?: any,
 *   approvals?: any[],
 *   nodes?: any[],
 *   attemptsByKey?: Record<string, any[]>,
 * }} state
 */
function makeAdapter(state = {}) {
    return {
        async getRun() {
            return state.run ?? null;
        },
        async listPendingApprovals() {
            return state.approvals ?? [];
        },
        async listNodes() {
            return state.nodes ?? [];
        },
        async listAttempts(runId, nodeId, iteration) {
            return state.attemptsByKey?.[`${runId}|${nodeId}|${iteration}`] ?? [];
        },
    };
}
