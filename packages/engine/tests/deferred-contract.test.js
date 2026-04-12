/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { jsx, jsxs } from "smithers/jsx-runtime";
import { Approval, Sequence, SmithersDb, Task, Timer, WaitForEvent, Workflow, runWorkflow, signalRun, } from "smithers";
import { approveNode, denyNode } from "../src/approvals.js";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";
const contractSchemas = {
    out: z.object({ v: z.number() }),
    decision: z.object({
        approved: z.boolean(),
        note: z.string().nullable(),
        decidedBy: z.string().nullable(),
        decidedAt: z.string().nullable(),
    }),
    eventOut: z.object({ ok: z.boolean() }),
};
function buildContractSmithers() {
    return createTestSmithers(contractSchemas);
}
describe("deferred contract", () => {
    test("approval pauses workflow until approved", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "deferred-approval-pauses",
                children: jsxs(Sequence, {
                    children: [
                        jsx(Approval, {
                            id: "gate",
                            output: outputs.decision,
                            request: { title: "Approve deployment" },
                        }),
                        jsx(Task, {
                            id: "after",
                            output: outputs.out,
                            children: { v: 1 },
                        }),
                    ],
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-approval");
            const beforeRows = await db.select().from(tables.out);
            expect(beforeRows).toHaveLength(0);
            await Effect.runPromise(approveNode(new SmithersDb(db), first.runId, "gate", 0));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const afterRows = await db.select().from(tables.out);
            expect(afterRows).toHaveLength(1);
            expect(afterRows[0]).toMatchObject({
                runId: first.runId,
                nodeId: "after",
                iteration: 0,
                v: 1,
            });
        }
        finally {
            cleanup();
        }
    });
    test("approval resumes workflow and task executes after approval", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "deferred-approval-persists-output",
                children: jsxs(Sequence, {
                    children: [
                        jsx(Approval, {
                            id: "gate",
                            output: outputs.decision,
                            request: { title: "Approve change" },
                        }),
                        jsx(Task, {
                            id: "after",
                            output: outputs.out,
                            children: { v: 7 },
                        }),
                    ],
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-approval");
            await Effect.runPromise(approveNode(new SmithersDb(db), first.runId, "gate", 0));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const rows = await db.select().from(tables.out);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                runId: first.runId,
                nodeId: "after",
                iteration: 0,
                v: 7,
            });
        }
        finally {
            cleanup();
        }
    });
    test("approval denial with onDeny=fail fails the workflow", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "deferred-approval-deny-fail",
                children: jsx(Approval, {
                    id: "gate",
                    output: outputs.decision,
                    request: { title: "Approve release" },
                    onDeny: "fail",
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-approval");
            await Effect.runPromise(denyNode(new SmithersDb(db), first.runId, "gate", 0));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("failed");
            const decisionRows = await db.select().from(tables.decision);
            expect(decisionRows).toHaveLength(0);
        }
        finally {
            cleanup();
        }
    });
    test("approval denial with onDeny=skip still records the denial and runs downstream work", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "deferred-approval-deny-skip",
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
                            output: outputs.out,
                            children: { v: 2 },
                        }),
                    ],
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-approval");
            await Effect.runPromise(denyNode(new SmithersDb(db), first.runId, "gate", 0));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const decisionRows = await db.select().from(tables.decision);
            expect(decisionRows).toHaveLength(1);
            expect(decisionRows[0]).toMatchObject({
                runId: first.runId,
                nodeId: "gate",
                iteration: 0,
                approved: false,
            });
            const outRows = await db.select().from(tables.out);
            expect(outRows).toHaveLength(1);
            expect(outRows[0]).toMatchObject({
                runId: first.runId,
                nodeId: "after",
                iteration: 0,
                v: 2,
            });
        }
        finally {
            cleanup();
        }
    });
    test("timer pauses workflow for specified duration then resumes", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "deferred-timer-duration",
                children: jsxs(Sequence, {
                    children: [
                        jsx(Timer, { id: "cooldown", duration: "120ms" }),
                        jsx(Task, {
                            id: "after",
                            output: outputs.out,
                            children: { v: 3 },
                        }),
                    ],
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-timer");
            await sleep(180);
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const rows = await db.select().from(tables.out);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                runId: first.runId,
                nodeId: "after",
                iteration: 0,
                v: 3,
            });
        }
        finally {
            cleanup();
        }
    });
    test("timer survives resume (pause → resume → timer still fires)", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "deferred-timer-resume",
                children: jsxs(Sequence, {
                    children: [
                        jsx(Timer, { id: "cooldown", duration: "1500ms" }),
                        jsx(Task, {
                            id: "after",
                            output: outputs.out,
                            children: { v: 4 },
                        }),
                    ],
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-timer");
            const second = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(second.status).toBe("waiting-timer");
            await sleep(1700);
            const third = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(third.status).toBe("finished");
            const rows = await db.select().from(tables.out);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                runId: first.runId,
                nodeId: "after",
                iteration: 0,
                v: 4,
            });
        }
        finally {
            cleanup();
        }
    });
    test("WaitForEvent suspends until a matching signal is delivered", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildContractSmithers();
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "deferred-wait-for-event",
                children: jsx(WaitForEvent, {
                    id: "wait",
                    event: "deploy.ready",
                    output: outputs.eventOut,
                }),
            }));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-event");
            await Effect.runPromise(signalRun(new SmithersDb(db), first.runId, "deploy.ready", { ok: true }));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            const rows = await db.select().from(tables.eventOut);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                runId: first.runId,
                nodeId: "wait",
                iteration: 0,
                ok: true,
            });
        }
        finally {
            cleanup();
        }
    });
});
