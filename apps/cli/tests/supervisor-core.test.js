import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { SUPERVISOR_EVENT_RUN_ID, supervisorPollEffect, } from "../src/supervisor.js";
const now = Date.now();
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    return { adapter, sqlite };
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
 */
async function listEventTypes(adapter, runId) {
    const events = await adapter.listEvents(runId, -1, 500);
    return events.map((event) => event.type);
}
describe("supervisor poll core", () => {
    test("auto-resumes stale runs", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-stale"));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            maxConcurrent: 3,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 4242;
                },
            },
        }));
        expect(summary).toEqual({
            staleCount: 1,
            resumedCount: 1,
            skippedCount: 0,
            durationMs: 0,
        });
        expect(resumed).toEqual(["run-stale"]);
        expect(await listEventTypes(adapter, "run-stale")).toContain("RunAutoResumed");
        sqlite.close();
    });
    test("does not resume healthy runs", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-fresh", {
            heartbeatAtMs: now - 1_000,
        }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 111;
                },
            },
        }));
        expect(summary.staleCount).toBe(0);
        expect(summary.resumedCount).toBe(0);
        expect(resumed.length).toBe(0);
        sqlite.close();
    });
    test("resumes waiting-timer runs when timer is due", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-timer-due", {
            status: "waiting-timer",
            heartbeatAtMs: null,
            runtimeOwnerId: null,
        }));
        await adapter.insertNode({
            runId: "run-timer-due",
            nodeId: "cooldown",
            iteration: 0,
            state: "waiting-timer",
            lastAttempt: 1,
            updatedAtMs: now - 1_000,
            outputTable: "",
            label: "timer:cooldown",
        });
        await adapter.insertAttempt({
            runId: "run-timer-due",
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
                    firesAtMs: now - 10,
                    firedAtMs: null,
                },
            }),
            responseText: null,
        });
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 999;
                },
            },
        }));
        expect(summary.staleCount).toBe(0);
        expect(summary.resumedCount).toBe(1);
        expect(summary.skippedCount).toBe(0);
        expect(resumed).toEqual(["run-timer-due"]);
        sqlite.close();
    });
    test("skips stale run when runtime owner pid is alive", async () => {
        const { adapter, sqlite } = createTestDb();
        await adapter.insertRun(runRow("run-alive", {
            runtimeOwnerId: `pid:${process.pid}:same-process`,
        }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => true,
                spawnResumeDetached: () => {
                    throw new Error("should not be called");
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(0);
        expect(summary.skippedCount).toBe(1);
        const events = await adapter.listEvents("run-alive", -1, 20);
        const skip = events.find((event) => event.type === "RunAutoResumeSkipped");
        expect(skip).toBeDefined();
        const payload = JSON.parse(skip.payloadJson);
        expect(payload.reason).toBe("pid-alive");
        sqlite.close();
    });
    test("dry-run reports stale runs without resuming", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-dry"));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            dryRun: true,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 222;
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(0);
        expect(summary.skippedCount).toBe(1);
        expect(resumed.length).toBe(0);
        expect(await listEventTypes(adapter, "run-dry")).not.toContain("RunAutoResumed");
        sqlite.close();
    });
    test("skips stale runs whose workflow file is missing", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-missing-workflow"));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => false,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 888;
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(0);
        expect(summary.skippedCount).toBe(1);
        expect(resumed).toHaveLength(0);
        const events = await adapter.listEvents("run-missing-workflow", -1, 20);
        const skip = events.find((event) => event.type === "RunAutoResumeSkipped");
        expect(skip).toBeDefined();
        const payload = JSON.parse(skip.payloadJson);
        expect(payload.reason).toBe("missing-workflow");
        sqlite.close();
    });
    test("ignores non-running stale runs", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-failed", { status: "failed" }));
        await adapter.insertRun(runRow("run-cancelled", { status: "cancelled" }));
        await adapter.insertRun(runRow("run-running"));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 777;
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(1);
        expect(resumed).toEqual(["run-running"]);
        sqlite.close();
    });
    test("rate-limits stale resumes per poll", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        for (let i = 0; i < 5; i++) {
            await adapter.insertRun(runRow(`run-${i}`, {
                heartbeatAtMs: now - 60_000 - i * 1_000,
            }));
        }
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            maxConcurrent: 3,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 333;
                },
            },
        }));
        expect(summary.staleCount).toBe(5);
        expect(summary.resumedCount).toBe(3);
        expect(summary.skippedCount).toBe(2);
        expect(resumed.length).toBe(3);
        let rateLimitedEvents = 0;
        for (let i = 0; i < 5; i++) {
            const events = await adapter.listEvents(`run-${i}`, -1, 50);
            for (const event of events) {
                if (event.type !== "RunAutoResumeSkipped")
                    continue;
                const payload = JSON.parse(event.payloadJson);
                if (payload.reason === "rate-limited")
                    rateLimitedEvents++;
            }
        }
        expect(rateLimitedEvents).toBe(2);
        sqlite.close();
    });
    test("poll emits SupervisorPollCompleted event", async () => {
        const { adapter, sqlite } = createTestDb();
        await adapter.insertRun(runRow("run-supervisor-event"));
        await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: () => 444,
            },
        }));
        const events = await adapter.listEvents(SUPERVISOR_EVENT_RUN_ID, -1, 20);
        const types = events.map((event) => event.type);
        expect(types).toContain("SupervisorPollCompleted");
        sqlite.close();
    });
    test("a freshly claimed run is not resumed twice across immediate polls", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-idempotent"));
        const options = {
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 555;
                },
            },
        };
        const first = await Effect.runPromise(supervisorPollEffect(options));
        const second = await Effect.runPromise(supervisorPollEffect(options));
        expect(first.resumedCount).toBe(1);
        expect(second.resumedCount).toBe(0);
        expect(resumed).toEqual(["run-idempotent"]);
        sqlite.close();
    });
});
