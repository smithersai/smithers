import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SUPERVISOR_EVENT_RUN_ID, supervisorPollEffect, } from "../src/supervisor.js";
const now = 1_750_000_000_000;
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    return { adapter, sqlite };
}
function createWorkflowDir() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-supervisor-e2e-"));
    return {
        dir,
        /**
     * @param {string} name
     */
        workflowPath(name, exists = true) {
            const path = join(dir, `${name}.tsx`);
            if (exists) {
                writeFileSync(path, `export const workflowName = "${name}";\n`);
            }
            return path;
        },
        cleanup() {
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
/**
 * @param {string} runId
 * @param {any} [extra]
 */
function runRow(runId, extra = {}) {
    return {
        runId,
        workflowName: "test-workflow",
        workflowPath: `/tmp/${runId}.tsx`,
        status: "running",
        createdAtMs: now - 120_000,
        startedAtMs: now - 120_000,
        heartbeatAtMs: now - 60_000,
        runtimeOwnerId: "pid:99999:owner",
        ...extra,
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} workflowPath
 * @param {number} firesAtMs
 */
async function insertDueTimerRun(adapter, runId, workflowPath, firesAtMs) {
    await adapter.insertRun(runRow(runId, {
        workflowPath,
        status: "waiting-timer",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
    }));
    await adapter.insertNode({
        runId,
        nodeId: "cooldown",
        iteration: 0,
        state: "waiting-timer",
        lastAttempt: 1,
        updatedAtMs: now - 1_000,
        outputTable: "",
        label: "timer:cooldown",
    });
    await adapter.insertAttempt({
        runId,
        nodeId: "cooldown",
        iteration: 0,
        attempt: 1,
        state: "waiting-timer",
        startedAtMs: now - 1_000,
        finishedAtMs: null,
        errorJson: null,
        jjPointer: null,
        jjCwd: null,
        cached: false,
        metaJson: JSON.stringify({
            kind: "timer",
            timer: {
                timerId: "cooldown",
                timerType: "duration",
                createdAtMs: now - 1_000,
                firesAtMs,
                firedAtMs: null,
            },
        }),
        responseText: null,
    });
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} workflowPath
 */
async function insertWaitingApprovalRun(adapter, runId, workflowPath) {
    await adapter.insertRun(runRow(runId, {
        workflowPath,
        status: "waiting-approval",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
    }));
    await adapter.insertNode({
        runId,
        nodeId: "review",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: 1,
        updatedAtMs: now - 2_000,
        outputTable: "",
        label: "approval:review",
    });
    await adapter.insertOrUpdateApproval({
        runId,
        nodeId: "review",
        iteration: 0,
        status: "requested",
        requestedAtMs: now - 2_000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
    });
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function listEvents(adapter, runId) {
    return (await adapter.listEvents(runId, -1, 200));
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} type
 */
async function eventPayloads(adapter, runId, type) {
    const events = await listEvents(adapter, runId);
    return events
        .filter((event) => event.type === type)
        .map((event) => JSON.parse(event.payloadJson));
}
describe("supervisor e2e", () => {
    test("supervisor detects and resumes multiple stale runs in priority order", async () => {
        const { adapter, sqlite } = createTestDb();
        const workflows = createWorkflowDir();
        const resumed = [];
        const originalHeartbeats = {
            "run-stalest": now - 120_000,
            "run-staler": now - 110_000,
            "run-stale": now - 100_000,
            "run-fresher": now - 90_000,
            "run-freshest": now - 80_000,
        };
        try {
            await adapter.insertRun(runRow("run-stalest", {
                workflowPath: workflows.workflowPath("run-stalest"),
                heartbeatAtMs: originalHeartbeats["run-stalest"],
            }));
            await adapter.insertRun(runRow("run-staler", {
                workflowPath: workflows.workflowPath("run-staler"),
                heartbeatAtMs: originalHeartbeats["run-staler"],
            }));
            await adapter.insertRun(runRow("run-stale", {
                workflowPath: workflows.workflowPath("run-stale"),
                heartbeatAtMs: originalHeartbeats["run-stale"],
            }));
            await adapter.insertRun(runRow("run-fresher", {
                workflowPath: workflows.workflowPath("run-fresher"),
                heartbeatAtMs: originalHeartbeats["run-fresher"],
            }));
            await adapter.insertRun(runRow("run-freshest", {
                workflowPath: workflows.workflowPath("run-freshest"),
                heartbeatAtMs: originalHeartbeats["run-freshest"],
            }));
            const summary = await Effect.runPromise(supervisorPollEffect({
                adapter,
                staleThresholdMs: 30_000,
                maxConcurrent: 3,
                supervisorId: "priority-e2e",
                deps: {
                    now: () => now,
                    isPidAlive: () => false,
                    spawnResumeDetached: (_workflowPath, runId) => {
                        resumed.push(runId);
                        return 4_000 + resumed.length;
                    },
                },
            }));
            expect(summary).toEqual({
                staleCount: 5,
                resumedCount: 3,
                skippedCount: 2,
                durationMs: 0,
            });
            expect(resumed.slice().sort()).toEqual([
                "run-stale",
                "run-staler",
                "run-stalest",
            ]);
            for (const runId of ["run-stalest", "run-staler", "run-stale"]) {
                expect(await eventPayloads(adapter, runId, "RunAutoResumed")).toEqual([
                    {
                        type: "RunAutoResumed",
                        runId,
                        lastHeartbeatAtMs: originalHeartbeats[runId],
                        staleDurationMs: now - originalHeartbeats[runId],
                        timestampMs: now,
                    },
                ]);
                const run = await adapter.getRun(runId);
                expect(run?.heartbeatAtMs).toBe(now);
                expect(run?.runtimeOwnerId).toBe("supervisor:priority-e2e");
            }
            for (const runId of ["run-fresher", "run-freshest"]) {
                expect(await eventPayloads(adapter, runId, "RunAutoResumeSkipped")).toEqual([
                    {
                        type: "RunAutoResumeSkipped",
                        runId,
                        reason: "rate-limited",
                        timestampMs: now,
                    },
                ]);
                expect(await eventPayloads(adapter, runId, "RunAutoResumed")).toEqual([]);
                const run = await adapter.getRun(runId);
                expect(run?.heartbeatAtMs).toBe(originalHeartbeats[runId]);
            }
        }
        finally {
            sqlite.close();
            workflows.cleanup();
        }
    });
    test("supervisor handles mixed run states correctly", async () => {
        const { adapter, sqlite } = createTestDb();
        const workflows = createWorkflowDir();
        const resumed = [];
        try {
            await adapter.insertRun(runRow("run-stale", {
                workflowPath: workflows.workflowPath("run-stale"),
                heartbeatAtMs: now - 90_000,
            }));
            await adapter.insertRun(runRow("run-fresh", {
                workflowPath: workflows.workflowPath("run-fresh"),
                heartbeatAtMs: now - 1_000,
            }));
            await adapter.insertRun(runRow("run-failed", {
                workflowPath: workflows.workflowPath("run-failed"),
                status: "failed",
                heartbeatAtMs: now - 120_000,
            }));
            await adapter.insertRun(runRow("run-cancelled", {
                workflowPath: workflows.workflowPath("run-cancelled"),
                status: "cancelled",
                heartbeatAtMs: now - 120_000,
            }));
            await insertDueTimerRun(adapter, "run-timer-due", workflows.workflowPath("run-timer-due"), now - 10);
            await insertWaitingApprovalRun(adapter, "run-waiting-approval", workflows.workflowPath("run-waiting-approval"));
            const summary = await Effect.runPromise(supervisorPollEffect({
                adapter,
                staleThresholdMs: 30_000,
                maxConcurrent: 5,
                deps: {
                    now: () => now,
                    isPidAlive: () => false,
                    spawnResumeDetached: (_workflowPath, runId) => {
                        resumed.push(runId);
                        return 5_000 + resumed.length;
                    },
                },
            }));
            expect(summary).toEqual({
                staleCount: 1,
                resumedCount: 2,
                skippedCount: 0,
                durationMs: 0,
            });
            expect(resumed.slice().sort()).toEqual(["run-stale", "run-timer-due"]);
            expect(await eventPayloads(adapter, "run-stale", "RunAutoResumed")).toHaveLength(1);
            expect(await eventPayloads(adapter, "run-fresh", "RunAutoResumed")).toEqual([]);
            expect(await eventPayloads(adapter, "run-failed", "RunAutoResumed")).toEqual([]);
            expect(await eventPayloads(adapter, "run-cancelled", "RunAutoResumed")).toEqual([]);
            expect(await eventPayloads(adapter, "run-waiting-approval", "RunAutoResumed")).toEqual([]);
        }
        finally {
            sqlite.close();
            workflows.cleanup();
        }
    });
    test("consecutive polls dont double-resume", async () => {
        const { adapter, sqlite } = createTestDb();
        const workflows = createWorkflowDir();
        const resumed = [];
        try {
            await adapter.insertRun(runRow("run-idempotent", {
                workflowPath: workflows.workflowPath("run-idempotent"),
                heartbeatAtMs: now - 75_000,
            }));
            const options = {
                adapter,
                staleThresholdMs: 30_000,
                supervisorId: "idempotent-e2e",
                deps: {
                    now: () => now,
                    isPidAlive: () => false,
                    spawnResumeDetached: (_workflowPath, runId) => {
                        resumed.push(runId);
                        return 6_000 + resumed.length;
                    },
                },
            };
            const first = await Effect.runPromise(supervisorPollEffect(options));
            const second = await Effect.runPromise(supervisorPollEffect(options));
            expect(first).toEqual({
                staleCount: 1,
                resumedCount: 1,
                skippedCount: 0,
                durationMs: 0,
            });
            expect(second).toEqual({
                staleCount: 0,
                resumedCount: 0,
                skippedCount: 0,
                durationMs: 0,
            });
            expect(resumed).toEqual(["run-idempotent"]);
            const run = await adapter.getRun("run-idempotent");
            expect(run?.heartbeatAtMs).toBe(now);
            expect(run?.runtimeOwnerId).toBe("supervisor:idempotent-e2e");
            expect(await eventPayloads(adapter, "run-idempotent", "RunAutoResumed")).toHaveLength(1);
            const supervisorEvents = await eventPayloads(adapter, SUPERVISOR_EVENT_RUN_ID, "SupervisorPollCompleted");
            expect(supervisorEvents).toEqual([
                {
                    type: "SupervisorPollCompleted",
                    runId: SUPERVISOR_EVENT_RUN_ID,
                    staleCount: 1,
                    resumedCount: 1,
                    skippedCount: 0,
                    durationMs: 0,
                    timestampMs: now,
                },
                {
                    type: "SupervisorPollCompleted",
                    runId: SUPERVISOR_EVENT_RUN_ID,
                    staleCount: 0,
                    resumedCount: 0,
                    skippedCount: 0,
                    durationMs: 0,
                    timestampMs: now,
                },
            ]);
        }
        finally {
            sqlite.close();
            workflows.cleanup();
        }
    });
    test("consecutive polls dont double-resume due waiting-timer runs", async () => {
        const { adapter, sqlite } = createTestDb();
        const workflows = createWorkflowDir();
        const resumed = [];
        try {
            await insertDueTimerRun(adapter, "run-timer-idempotent", workflows.workflowPath("run-timer-idempotent"), now - 10);
            const options = {
                adapter,
                staleThresholdMs: 30_000,
                supervisorId: "timer-idempotent-e2e",
                deps: {
                    now: () => now,
                    isPidAlive: () => false,
                    spawnResumeDetached: (_workflowPath, runId) => {
                        resumed.push(runId);
                        return 7_000 + resumed.length;
                    },
                },
            };
            const first = await Effect.runPromise(supervisorPollEffect(options));
            const second = await Effect.runPromise(supervisorPollEffect(options));
            expect(first).toEqual({
                staleCount: 0,
                resumedCount: 1,
                skippedCount: 0,
                durationMs: 0,
            });
            expect(second).toEqual({
                staleCount: 0,
                resumedCount: 0,
                skippedCount: 0,
                durationMs: 0,
            });
            expect(resumed).toEqual(["run-timer-idempotent"]);
            const run = await adapter.getRun("run-timer-idempotent");
            expect(run?.runtimeOwnerId).toBe("supervisor:timer-idempotent-e2e");
            expect(run?.heartbeatAtMs).toBe(now);
            expect(await eventPayloads(adapter, "run-timer-idempotent", "RunAutoResumed")).toHaveLength(1);
        }
        finally {
            sqlite.close();
            workflows.cleanup();
        }
    });
    test("supervisor emits accurate summary metrics", async () => {
        const { adapter, sqlite } = createTestDb();
        const workflows = createWorkflowDir();
        const resumed = [];
        try {
            await adapter.insertRun(runRow("run-dead-a", {
                workflowPath: workflows.workflowPath("run-dead-a"),
                heartbeatAtMs: now - 120_000,
                runtimeOwnerId: "pid:2001:dead-a",
            }));
            await adapter.insertRun(runRow("run-dead-b", {
                workflowPath: workflows.workflowPath("run-dead-b"),
                heartbeatAtMs: now - 110_000,
                runtimeOwnerId: "pid:2002:dead-b",
            }));
            await adapter.insertRun(runRow("run-alive", {
                workflowPath: workflows.workflowPath("run-alive"),
                heartbeatAtMs: now - 100_000,
                runtimeOwnerId: "pid:1111:alive",
            }));
            await adapter.insertRun(runRow("run-missing-a", {
                workflowPath: workflows.workflowPath("run-missing-a", false),
                heartbeatAtMs: now - 90_000,
                runtimeOwnerId: "pid:3001:dead-missing-a",
            }));
            const summary = await Effect.runPromise(supervisorPollEffect({
                adapter,
                staleThresholdMs: 30_000,
                maxConcurrent: 10,
                deps: {
                    now: () => now,
                    isPidAlive: (pid) => pid === 1111,
                    spawnResumeDetached: (_workflowPath, runId) => {
                        resumed.push(runId);
                        return 7_000 + resumed.length;
                    },
                },
            }));
            expect(summary).toEqual({
                staleCount: 4,
                resumedCount: 2,
                skippedCount: 2,
                durationMs: 0,
            });
            expect(resumed.slice().sort()).toEqual(["run-dead-a", "run-dead-b"]);
            expect(await eventPayloads(adapter, "run-alive", "RunAutoResumeSkipped")).toEqual([
                {
                    type: "RunAutoResumeSkipped",
                    runId: "run-alive",
                    reason: "pid-alive",
                    timestampMs: now,
                },
            ]);
            expect(await eventPayloads(adapter, "run-missing-a", "RunAutoResumeSkipped")).toEqual([
                {
                    type: "RunAutoResumeSkipped",
                    runId: "run-missing-a",
                    reason: "missing-workflow",
                    timestampMs: now,
                },
            ]);
            const supervisorEvents = await eventPayloads(adapter, SUPERVISOR_EVENT_RUN_ID, "SupervisorPollCompleted");
            expect(supervisorEvents).toEqual([
                {
                    type: "SupervisorPollCompleted",
                    runId: SUPERVISOR_EVENT_RUN_ID,
                    staleCount: 4,
                    resumedCount: 2,
                    skippedCount: 2,
                    durationMs: 0,
                    timestampMs: now,
                },
            ]);
        }
        finally {
            sqlite.close();
            workflows.cleanup();
        }
    });
});
