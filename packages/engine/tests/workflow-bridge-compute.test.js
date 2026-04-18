import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { EventBus } from "../src/events.js";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { executeTaskBridge } from "../src/effect/workflow-bridge.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
/**
 * @param {any} outputTable
 * @param {z.ZodObject<any>} outputSchema
 * @param {Partial<TaskDescriptor>} [overrides]
 * @returns {TaskDescriptor}
 */
function makeTaskDescriptor(outputTable, outputSchema, overrides = {}) {
    return {
        nodeId: "bridge-compute-task",
        ordinal: 0,
        iteration: 0,
        outputTable,
        outputTableName: outputTable._?.name ?? "out",
        outputSchema,
        needsApproval: false,
        skipIf: false,
        retries: 0,
        timeoutMs: null,
        heartbeatTimeoutMs: null,
        continueOnFail: false,
        computeFn: () => ({ value: 42 }),
        ...overrides,
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} workflowName
 */
async function insertRun(adapter, runId, workflowName) {
    await adapter.insertRun({
        runId,
        workflowName,
        workflowHash: "workflow-hash",
        status: "running",
        createdAtMs: Date.now(),
    });
}
describe("workflow bridge compute-task contract", () => {
    test("executes a bridge-managed compute task without the legacy executor", async () => {
        const schema = z.object({ value: z.number() });
        const { tables, db, cleanup } = createTestSmithers({ out: schema });
        try {
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            const runId = "bridge-compute-success";
            await insertRun(adapter, runId, "bridge-compute-success");
            let runtimeSnapshot = null;
            const desc = makeTaskDescriptor(tables.out, schema, {
                computeFn: () => {
                    const runtime = requireTaskRuntime();
                    runtimeSnapshot = {
                        runId: runtime.runId,
                        stepId: runtime.stepId,
                        attempt: runtime.attempt,
                        iteration: runtime.iteration,
                        lastHeartbeat: runtime.lastHeartbeat,
                    };
                    runtime.heartbeat({ progress: 50 });
                    return {
                        value: 42,
                        runId: "shadowed",
                        nodeId: "shadowed",
                        iteration: 999,
                    };
                },
            });
            const eventBus = new EventBus({ db: adapter });
            const eventTypes = [];
            eventBus.on("event", (event) => {
                eventTypes.push(event.type);
            });
            await executeTaskBridge(adapter, db, runId, desc, new Map([[desc.nodeId, desc]]), null, eventBus, {
                rootDir: process.cwd(),
                allowNetwork: false,
                maxOutputBytes: 1_000_000,
                toolTimeoutMs: 30_000,
            }, "bridge-compute-success", false);
            const rows = await db.select().from(tables.out);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                runId,
                nodeId: desc.nodeId,
                iteration: 0,
                value: 42,
            });
            expect(runtimeSnapshot).toEqual({
                runId,
                stepId: desc.nodeId,
                attempt: 1,
                iteration: 0,
                lastHeartbeat: null,
            });
            const attempts = await adapter.listAttempts(runId, desc.nodeId, 0);
            expect(attempts).toHaveLength(1);
            expect(attempts[0]?.state).toBe("finished");
            expect(JSON.parse(attempts[0]?.heartbeatDataJson ?? "null")).toEqual({
                progress: 50,
            });
            expect(eventTypes).toContain("NodeStarted");
            expect(eventTypes).toContain("TaskHeartbeat");
            expect(eventTypes).toContain("NodeFinished");
        }
        finally {
            cleanup();
        }
    }, 30_000);
    test("retries a bridge-managed compute task and restores the previous heartbeat checkpoint", async () => {
        const schema = z.object({ value: z.number() });
        const { tables, db, cleanup } = createTestSmithers({ out: schema });
        try {
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            const runId = "bridge-compute-retry";
            await insertRun(adapter, runId, "bridge-compute-retry");
            let calls = 0;
            const checkpoints = [];
            const desc = makeTaskDescriptor(tables.out, schema, {
                retries: 1,
                computeFn: () => {
                    calls += 1;
                    const runtime = requireTaskRuntime();
                    checkpoints.push(runtime.lastHeartbeat);
                    if (calls === 1) {
                        runtime.heartbeat({ cursor: "page-5" });
                        throw new Error("fail first attempt");
                    }
                    expect(runtime.lastHeartbeat).toEqual({ cursor: "page-5" });
                    return { value: 2 };
                },
            });
            const eventBus = new EventBus({ db: adapter });
            const eventTypes = [];
            eventBus.on("event", (event) => {
                eventTypes.push(event.type);
            });
            await executeTaskBridge(adapter, db, runId, desc, new Map([[desc.nodeId, desc]]), null, eventBus, {
                rootDir: process.cwd(),
                allowNetwork: false,
                maxOutputBytes: 1_000_000,
                toolTimeoutMs: 30_000,
            }, "bridge-compute-retry", false);
            await executeTaskBridge(adapter, db, runId, desc, new Map([[desc.nodeId, desc]]), null, eventBus, {
                rootDir: process.cwd(),
                allowNetwork: false,
                maxOutputBytes: 1_000_000,
                toolTimeoutMs: 30_000,
            }, "bridge-compute-retry", false);
            const rows = await db.select().from(tables.out);
            expect(rows).toHaveLength(1);
            expect(rows[0]?.value).toBe(2);
            expect(calls).toBe(2);
            expect(checkpoints).toEqual([null, { cursor: "page-5" }]);
            const attempts = await adapter.listAttempts(runId, desc.nodeId, 0);
            expect(attempts).toHaveLength(2);
            expect(attempts.some((attempt) => attempt.state === "failed")).toBe(true);
            expect(attempts.some((attempt) => attempt.state === "finished")).toBe(true);
            expect(eventTypes.filter((type) => type === "NodeStarted")).toHaveLength(2);
            expect(eventTypes).toContain("NodeFailed");
            expect(eventTypes).toContain("NodeRetrying");
            expect(eventTypes).toContain("NodeFinished");
        }
        finally {
            cleanup();
        }
    }, 30_000);
    test("records timeout failures for a bridge-managed compute task without the legacy executor", async () => {
        const schema = z.object({ value: z.number() });
        const { tables, db, cleanup } = createTestSmithers({ out: schema });
        try {
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            const runId = "bridge-compute-timeout";
            await insertRun(adapter, runId, "bridge-compute-timeout");
            const desc = makeTaskDescriptor(tables.out, schema, {
                timeoutMs: 20,
                computeFn: async () => {
                    await Bun.sleep(100);
                    return { value: 1 };
                },
            });
            const eventBus = new EventBus({ db: adapter });
            const eventTypes = [];
            eventBus.on("event", (event) => {
                eventTypes.push(event.type);
            });
            await executeTaskBridge(adapter, db, runId, desc, new Map([[desc.nodeId, desc]]), null, eventBus, {
                rootDir: process.cwd(),
                allowNetwork: false,
                maxOutputBytes: 1_000_000,
                toolTimeoutMs: 30_000,
            }, "bridge-compute-timeout", false);
            const rows = await db.select().from(tables.out);
            expect(rows).toHaveLength(0);
            const attempts = await adapter.listAttempts(runId, desc.nodeId, 0);
            expect(attempts).toHaveLength(1);
            expect(attempts[0]?.state).toBe("failed");
            const errorJson = JSON.parse(attempts[0]?.errorJson ?? "{}");
            expect(errorJson.code).toBe("TASK_TIMEOUT");
            expect(eventTypes).toContain("NodeFailed");
        }
        finally {
            cleanup();
        }
    }, 30_000);
    test("records heartbeat-timeout failures and retries for a bridge-managed compute task", async () => {
        const schema = z.object({ value: z.number() });
        const { tables, db, cleanup } = createTestSmithers({ out: schema });
        try {
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            const runId = "bridge-compute-heartbeat-timeout";
            await insertRun(adapter, runId, "bridge-compute-heartbeat-timeout");
            let calls = 0;
            const desc = makeTaskDescriptor(tables.out, schema, {
                retries: 1,
                heartbeatTimeoutMs: 120,
                computeFn: async () => {
                    calls += 1;
                    const runtime = requireTaskRuntime();
                    if (calls === 1) {
                        await Bun.sleep(260);
                        return { value: 1 };
                    }
                    runtime.heartbeat({ progress: 1 });
                    await Bun.sleep(20);
                    runtime.heartbeat({ progress: 2 });
                    return { value: 2 };
                },
            });
            const eventBus = new EventBus({ db: adapter });
            const eventTypes = [];
            eventBus.on("event", (event) => {
                eventTypes.push(event.type);
            });
            await executeTaskBridge(adapter, db, runId, desc, new Map([[desc.nodeId, desc]]), null, eventBus, {
                rootDir: process.cwd(),
                allowNetwork: false,
                maxOutputBytes: 1_000_000,
                toolTimeoutMs: 30_000,
            }, "bridge-compute-heartbeat-timeout", false);
            await executeTaskBridge(adapter, db, runId, desc, new Map([[desc.nodeId, desc]]), null, eventBus, {
                rootDir: process.cwd(),
                allowNetwork: false,
                maxOutputBytes: 1_000_000,
                toolTimeoutMs: 30_000,
            }, "bridge-compute-heartbeat-timeout", false);
            const rows = await db.select().from(tables.out);
            expect(rows).toHaveLength(1);
            expect(rows[0]?.value).toBe(2);
            expect(calls).toBe(2);
            const attempts = await adapter.listAttempts(runId, desc.nodeId, 0);
            expect(attempts).toHaveLength(2);
            const failedAttempt = attempts.find((attempt) => attempt.state === "failed");
            expect(failedAttempt).toBeDefined();
            const failedError = JSON.parse(failedAttempt?.errorJson ?? "{}");
            expect(failedError.code).toBe("TASK_HEARTBEAT_TIMEOUT");
            expect(eventTypes).toContain("TaskHeartbeatTimeout");
            expect(eventTypes).toContain("NodeRetrying");
            expect(eventTypes).toContain("NodeFinished");
        }
        finally {
            cleanup();
        }
    }, 30_000);
});
