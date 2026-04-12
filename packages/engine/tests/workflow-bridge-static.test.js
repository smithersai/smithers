import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { EventBus } from "../src/events.js";
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
        nodeId: "bridge-static-task",
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
        staticPayload: { value: 42 },
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
describe("workflow bridge static-task contract", () => {
    test("executes a bridge-managed static task without the legacy executor", async () => {
        const schema = z.object({ value: z.number() });
        const { tables, db, cleanup } = createTestSmithers({ out: schema });
        try {
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            const runId = "bridge-static-success";
            await insertRun(adapter, runId, "bridge-static-success");
            const desc = makeTaskDescriptor(tables.out, schema);
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
            }, "bridge-static-success", false);
            const rows = await db.select().from(tables.out);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                runId,
                nodeId: desc.nodeId,
                iteration: 0,
                value: 42,
            });
            const attempts = await adapter.listAttempts(runId, desc.nodeId, 0);
            expect(attempts).toHaveLength(1);
            expect(attempts[0]?.state).toBe("finished");
            expect(eventTypes).toEqual(["NodeStarted", "NodeFinished"]);
        }
        finally {
            cleanup();
        }
    }, 30_000);
    test("records validation failures for a bridge-managed static task without the legacy executor", async () => {
        const schema = z.object({ value: z.number() });
        const { tables, db, cleanup } = createTestSmithers({ out: schema });
        try {
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            const runId = "bridge-static-failure";
            await insertRun(adapter, runId, "bridge-static-failure");
            const desc = makeTaskDescriptor(tables.out, schema, {
                staticPayload: { value: "not-a-number" },
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
            }, "bridge-static-failure", false);
            const rows = await db.select().from(tables.out);
            expect(rows).toHaveLength(0);
            const attempts = await adapter.listAttempts(runId, desc.nodeId, 0);
            expect(attempts).toHaveLength(1);
            expect(attempts[0]?.state).toBe("failed");
            expect(eventTypes).toEqual(["NodeStarted", "NodeFailed"]);
        }
        finally {
            cleanup();
        }
    }, 30_000);
});
