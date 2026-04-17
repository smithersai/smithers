/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { jsx, jsxs } from "smithers-orchestrator/jsx-runtime";
import { Approval, Sequence, SmithersDb, Task, WaitForEvent, Workflow, approvalDecisionSchema, runWorkflow, signalRun, } from "smithers-orchestrator";
import { approveNode, denyNode } from "../src/approvals.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";
const contractSchemas = {
    decision: approvalDecisionSchema,
    eventOut: z.object({ ok: z.boolean() }),
    result: z.object({ value: z.number() }),
};
function buildContractSmithers() {
    return createTestSmithers(contractSchemas);
}
describe("durable deferred contract", () => {
    test("approval waits for a decision and resumes through approveNode", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "durable-deferred-approval-approve",
                children: jsxs(Sequence, {
                    children: [
                        jsx(Approval, {
                            id: "gate",
                            output: outputs.decision,
                            request: { title: "Approve deployment" },
                        }),
                        jsx(Task, {
                            id: "after",
                            output: outputs.result,
                            children: { value: 1 },
                        }),
                    ],
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-approval");
            await Effect.runPromise(approveNode(new SmithersDb(db), first.runId, "gate", 0, "ship it", "reviewer"));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const decisionRows = await db.select().from(tables.decision);
            expect(decisionRows).toEqual([
                expect.objectContaining({
                    runId: first.runId,
                    nodeId: "gate",
                    iteration: 0,
                    approved: true,
                    note: "ship it",
                    decidedBy: "reviewer",
                }),
            ]);
            const resultRows = await db.select().from(tables.result);
            expect(resultRows).toEqual([
                expect.objectContaining({
                    runId: first.runId,
                    nodeId: "after",
                    iteration: 0,
                    value: 1,
                }),
            ]);
        }
        finally {
            cleanup();
        }
    });
    test("approval denial preserves existing onDeny behavior", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "durable-deferred-approval-deny",
                children: jsxs(Sequence, {
                    children: [
                        jsx(Approval, {
                            id: "gate",
                            output: outputs.decision,
                            request: { title: "Approve rollout" },
                            onDeny: "skip",
                        }),
                        jsx(Task, {
                            id: "after",
                            output: outputs.result,
                            children: { value: 2 },
                        }),
                    ],
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-approval");
            await Effect.runPromise(denyNode(new SmithersDb(db), first.runId, "gate", 0, "not yet", "reviewer"));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const decisionRows = await db.select().from(tables.decision);
            expect(decisionRows).toEqual([
                expect.objectContaining({
                    runId: first.runId,
                    nodeId: "gate",
                    iteration: 0,
                    approved: false,
                    note: "not yet",
                    decidedBy: "reviewer",
                }),
            ]);
            const resultRows = await db.select().from(tables.result);
            expect(resultRows).toEqual([
                expect.objectContaining({
                    runId: first.runId,
                    nodeId: "after",
                    iteration: 0,
                    value: 2,
                }),
            ]);
        }
        finally {
            cleanup();
        }
    });
    test("WaitForEvent waits for signalRun and persists the delivered payload", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "durable-deferred-wait-for-event",
                children: jsx(WaitForEvent, {
                    id: "wait",
                    event: "deploy.ready",
                    correlationId: "ticket-42",
                    output: outputs.eventOut,
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-event");
            await Effect.runPromise(signalRun(new SmithersDb(db), first.runId, "deploy.ready", { ok: true }, { correlationId: "ticket-42", receivedBy: "tester" }));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const rows = await db.select().from(tables.eventOut);
            expect(rows).toEqual([
                expect.objectContaining({
                    runId: first.runId,
                    nodeId: "wait",
                    iteration: 0,
                    ok: true,
                }),
            ]);
        }
        finally {
            cleanup();
        }
    });
    test("WaitForEvent ignores non-matching signals and resolves on the matching one", async () => {
        const { smithers, outputs, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "durable-deferred-wait-for-event-correlation",
                children: jsx(WaitForEvent, {
                    id: "wait",
                    event: "deploy.ready",
                    correlationId: "ticket-42",
                    output: outputs.eventOut,
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-event");
            const adapter = new SmithersDb(db);
            await Effect.runPromise(signalRun(adapter, first.runId, "deploy.ready", { ok: false }, { correlationId: "ticket-99", receivedBy: "tester" }));
            const stillWaiting = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(stillWaiting.status).toBe("waiting-event");
            await Effect.runPromise(signalRun(adapter, first.runId, "deploy.ready", { ok: true }, { correlationId: "ticket-42", receivedBy: "tester" }));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
        }
        finally {
            cleanup();
        }
    });
});
