/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { getSqlMessageStorage } from "../src/effect/sql-message-storage.js";
import { SmithersDb, Task, Workflow, runWorkflow } from "smithers";
import { jsx } from "smithers/jsx-runtime";
import { createTestDb, createTestSmithers } from "../../smithers/tests/helpers.js";
import { ddl, schema } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
const contractSchemas = {
    activity: z.object({ value: z.number() }),
};
function buildContractSmithers() {
    return createTestSmithers(contractSchemas);
}
describe("sql message storage contract", () => {
    test("event persistence round-trips between SmithersDb and SqlMessageStorage", async () => {
        const { db, cleanup } = createTestDb(schema, ddl);
        try {
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            const storage = getSqlMessageStorage(db);
            await adapter.insertRun({
                runId: "sql-storage-roundtrip",
                workflowName: "sql-storage-roundtrip",
                status: "running",
                createdAtMs: 1,
            });
            await adapter.insertEventWithNextSeq({
                runId: "sql-storage-roundtrip",
                timestampMs: 10,
                type: "RunStarted",
                payloadJson: JSON.stringify({ runId: "sql-storage-roundtrip" }),
            });
            await adapter.insertEventWithNextSeq({
                runId: "sql-storage-roundtrip",
                timestampMs: 11,
                type: "NodeStarted",
                payloadJson: JSON.stringify({ nodeId: "task-1" }),
            });
            const adapterEvents = await adapter.listEventHistory("sql-storage-roundtrip");
            const storageEvents = await storage.listEventHistory("sql-storage-roundtrip");
            expect(storageEvents).toEqual(adapterEvents);
            expect(await storage.getLastEventSeq("sql-storage-roundtrip")).toBe(1);
        }
        finally {
            cleanup();
        }
    });
    test("replay produces the same persisted state without re-executing finished work", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        let calls = 0;
        const agent = {
            id: "sql-storage-replay-agent",
            tools: {},
            generate: async () => {
                calls += 1;
                return { output: { value: 21 } };
            },
        };
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "sql-storage-replay",
                children: jsx(Task, {
                    id: "persisted-task",
                    output: outputs.activity,
                    agent,
                    children: "use persisted activity output",
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: "sql-storage-replay",
            }));
            expect(first.status).toBe("finished");
            const adapter = new SmithersDb(db);
            const beforeState = {
                attempts: await adapter.listAttempts(first.runId, "persisted-task", 0),
                rows: await db.select().from(tables.activity),
            };
            const beforeEvents = await getSqlMessageStorage(db).listEventHistory(first.runId);
            const beforeNodeFinished = beforeEvents.filter((event) => event.type === "NodeFinished");
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            expect(calls).toBe(1);
            const afterState = {
                attempts: await adapter.listAttempts(first.runId, "persisted-task", 0),
                rows: await db.select().from(tables.activity),
            };
            const afterRun = await adapter.getRun(first.runId);
            const afterEvents = await getSqlMessageStorage(db).listEventHistory(first.runId);
            const afterNodeFinished = afterEvents.filter((event) => event.type === "NodeFinished");
            expect(afterState).toEqual(beforeState);
            expect(afterRun?.status).toBe("finished");
            expect(afterNodeFinished).toHaveLength(beforeNodeFinished.length);
        }
        finally {
            cleanup();
        }
    }, 30_000);
});
