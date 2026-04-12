import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { SmithersDb } from "@smithers/db/adapter";
import { Effect } from "effect";
import { approveNode, denyNode, } from "../src/approvals.js";
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), db, sqlite };
}
describe("approveNode", () => {
    test("sets node state to pending after approval", async () => {
        const { adapter } = createTestDb();
        // Insert a run and a node in waiting_approval state
        await adapter.insertRun({
            runId: "run-1",
            workflowName: "test-wf",
            workflowHash: "h",
            status: "waiting-approval",
            createdAtMs: Date.now(),
        });
        await adapter.insertNode({
            runId: "run-1",
            nodeId: "node-1",
            iteration: 0,
            state: "waiting_approval",
            lastAttempt: null,
            updatedAtMs: Date.now(),
            outputTable: "approval_output",
            label: "Approval Gate",
        });
        // Request approval first so the approval record exists
        await adapter.insertOrUpdateApproval({
            runId: "run-1",
            nodeId: "node-1",
            iteration: 0,
            status: "requested",
            requestedAtMs: Date.now() - 1000,
            decidedAtMs: null,
            note: null,
            decidedBy: null,
        });
        await Effect.runPromise(approveNode(adapter, "run-1", "node-1", 0, "looks good", "alice"));
        const approval = await adapter.getApproval("run-1", "node-1", 0);
        const node = await adapter.getNode("run-1", "node-1", 0);
        const run = await adapter.getRun("run-1");
        expect(approval?.status).toBe("approved");
        expect(approval?.note).toBe("looks good");
        expect(approval?.decidedBy).toBe("alice");
        expect(node?.state).toBe("pending");
        expect(node?.outputTable).toBe("approval_output");
        expect(node?.label).toBe("Approval Gate");
        expect(run?.status).toBe("waiting-event");
    });
    test("approveNode without note/decidedBy defaults to null", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun({
            runId: "run-2",
            workflowName: "test-wf",
            workflowHash: "h",
            status: "running",
            createdAtMs: Date.now(),
        });
        await adapter.insertNode({
            runId: "run-2",
            nodeId: "node-1",
            iteration: 0,
            state: "waiting_approval",
            lastAttempt: null,
            updatedAtMs: Date.now(),
            outputTable: "",
            label: null,
        });
        await Effect.runPromise(approveNode(adapter, "run-2", "node-1", 0));
        const approval = await adapter.getApproval("run-2", "node-1", 0);
        expect(approval?.status).toBe("approved");
        expect(approval?.note).toBeNull();
        expect(approval?.decidedBy).toBeNull();
    });
});
describe("denyNode", () => {
    test("sets node state to failed after denial", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun({
            runId: "run-3",
            workflowName: "test-wf",
            workflowHash: "h",
            status: "waiting-approval",
            createdAtMs: Date.now(),
        });
        await adapter.insertNode({
            runId: "run-3",
            nodeId: "node-1",
            iteration: 0,
            state: "waiting_approval",
            lastAttempt: null,
            updatedAtMs: Date.now(),
            outputTable: "approval_output",
            label: "Approval Gate",
        });
        await adapter.insertOrUpdateApproval({
            runId: "run-3",
            nodeId: "node-1",
            iteration: 0,
            status: "requested",
            requestedAtMs: Date.now() - 500,
            decidedAtMs: null,
            note: null,
            decidedBy: null,
        });
        await Effect.runPromise(denyNode(adapter, "run-3", "node-1", 0, "not ready", "bob"));
        const approval = await adapter.getApproval("run-3", "node-1", 0);
        const node = await adapter.getNode("run-3", "node-1", 0);
        const run = await adapter.getRun("run-3");
        expect(approval?.status).toBe("denied");
        expect(approval?.note).toBe("not ready");
        expect(approval?.decidedBy).toBe("bob");
        expect(node?.state).toBe("failed");
        expect(node?.outputTable).toBe("approval_output");
        expect(node?.label).toBe("Approval Gate");
        expect(run?.status).toBe("waiting-event");
    });
    test("denyNode without note/decidedBy defaults to null", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun({
            runId: "run-4",
            workflowName: "test-wf",
            workflowHash: "h",
            status: "running",
            createdAtMs: Date.now(),
        });
        await adapter.insertNode({
            runId: "run-4",
            nodeId: "node-1",
            iteration: 0,
            state: "waiting_approval",
            lastAttempt: null,
            updatedAtMs: Date.now(),
            outputTable: "",
            label: null,
        });
        await Effect.runPromise(denyNode(adapter, "run-4", "node-1", 0));
        const approval = await adapter.getApproval("run-4", "node-1", 0);
        expect(approval?.status).toBe("denied");
        expect(approval?.note).toBeNull();
        expect(approval?.decidedBy).toBeNull();
    });
});
