/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { Approval, Workflow, Task, Sequence, runWorkflow, approvalDecisionSchema, approvalRankingSchema, approvalSelectionSchema, } from "smithers";
import { approveNode, denyNode } from "../src/approvals.js";
import { SmithersDb } from "@smithers/db/adapter";
import { renderPrometheusMetrics } from "@smithers/observability";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
const schemas = {
    a: z.object({ v: z.number() }),
    b: z.object({ v: z.number() }),
};
/**
 * @param {any} workflow
 * @param {string} dbPath
 * @param {any} opts
 */
function runInTestRoot(workflow, dbPath, opts) {
    return Effect.runPromise(runWorkflow(workflow, {
        ...opts,
        rootDir: dirname(dbPath),
    }));
}
/**
 * @param {"approval" | "event"} kind
 * @returns {number}
 */
function asyncPendingMetric(kind) {
    const text = renderPrometheusMetrics();
    const match = text.match(new RegExp(`^smithers_external_wait_async_pending\\{kind="${kind}"\\} ([^\\n]+)$`, "m"));
    return match ? Number(match[1]) : 0;
}
describe("approval extended", () => {
    test("denial with onDeny=fail fails the workflow", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(schemas);
        const workflow = smithers(() => (<Workflow name="deny-fail">
        <Task id="gate" output={outputs.a} needsApproval>
          {{ v: 1 }}
        </Task>
      </Workflow>));
        const first = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(first.status).toBe("waiting-approval");
        const adapter = new SmithersDb(db);
        await Effect.runPromise(denyNode(adapter, first.runId, "gate", 0, "rejected", "tester"));
        const resumed = await runInTestRoot(workflow, dbPath, {
            input: {},
            runId: first.runId,
            resume: true,
        });
        expect(resumed.status).toBe("failed");
        cleanup();
    });
    test("denial with onDeny=continue continues workflow", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers(schemas);
        const workflow = smithers(() => (<Workflow name="deny-continue">
        <Sequence>
          <Task id="gate" output={outputs.a} needsApproval continueOnFail>
            {{ v: 1 }}
          </Task>
          <Task id="after" output={outputs.b}>
            {{ v: 2 }}
          </Task>
        </Sequence>
      </Workflow>));
        const first = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(first.status).toBe("waiting-approval");
        const adapter = new SmithersDb(db);
        await Effect.runPromise(denyNode(adapter, first.runId, "gate", 0, "nope", "tester"));
        const resumed = await runInTestRoot(workflow, dbPath, {
            input: {},
            runId: first.runId,
            resume: true,
        });
        // With continueOnFail, denial should not block the workflow
        expect(["finished", "failed"].includes(resumed.status)).toBe(true);
        cleanup();
    });
    test("multiple approvals in sequence", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers(schemas);
        const workflow = smithers(() => (<Workflow name="multi-approval">
        <Sequence>
          <Task id="gate1" output={outputs.a} needsApproval>
            {{ v: 1 }}
          </Task>
          <Task id="gate2" output={outputs.b} needsApproval>
            {{ v: 2 }}
          </Task>
        </Sequence>
      </Workflow>));
        // First run - stops at gate1
        const r1 = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(r1.status).toBe("waiting-approval");
        const adapter = new SmithersDb(db);
        await Effect.runPromise(approveNode(adapter, r1.runId, "gate1", 0, "ok", "tester"));
        // Resume - stops at gate2
        const r2 = await runInTestRoot(workflow, dbPath, {
            input: {},
            runId: r1.runId,
            resume: true,
        });
        expect(r2.status).toBe("waiting-approval");
        await Effect.runPromise(approveNode(adapter, r1.runId, "gate2", 0, "ok", "tester"));
        // Final resume - finishes
        const r3 = await runInTestRoot(workflow, dbPath, {
            input: {},
            runId: r1.runId,
            resume: true,
        });
        expect(r3.status).toBe("finished");
        cleanup();
    });
    test("approval persists the approver and note", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(schemas);
        const workflow = smithers(() => (<Workflow name="approval-meta">
        <Task id="gate" output={outputs.a} needsApproval>
          {{ v: 1 }}
        </Task>
      </Workflow>));
        const r = await runInTestRoot(workflow, dbPath, { input: {} });
        const adapter = new SmithersDb(db);
        await Effect.runPromise(approveNode(adapter, r.runId, "gate", 0, "looks good", "alice"));
        const approval = await adapter.getApproval(r.runId, "gate", 0);
        expect(approval).toBeDefined();
        expect(approval?.status).toBe("approved");
        expect(approval?.decidedBy).toBe("alice");
        expect(approval?.note).toBe("looks good");
        cleanup();
    });
    test("async approvals allow unrelated downstream work before approval resolves", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            approval: approvalDecisionSchema,
            result: z.object({ v: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="async-approval-flow">
        <Sequence>
          <Approval id="gate" output={outputs.approval} request={{ title: "Ship it?" }} async/>
          <Task id="after" output={outputs.result}>
            {{ v: 2 }}
          </Task>
        </Sequence>
      </Workflow>));
        try {
            const metricBefore = asyncPendingMetric("approval");
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            expect(asyncPendingMetric("approval") - metricBefore).toBe(1);
            const beforeApproval = await db.select().from(tables.result);
            expect(beforeApproval).toEqual([
                expect.objectContaining({
                    runId: first.runId,
                    nodeId: "after",
                    iteration: 0,
                    v: 2,
                }),
            ]);
            const adapter = new SmithersDb(db);
            await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "ok", "tester"));
            expect(asyncPendingMetric("approval")).toBe(metricBefore);
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            expect(resumed.status).toBe("finished");
        }
        finally {
            cleanup();
        }
    });
    test("selection approval persists typed selection output", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            selection: approvalSelectionSchema,
            result: z.object({ selected: z.string() }),
        });
        const workflow = smithers((ctx) => {
            const selection = ctx.outputMaybe("selection", { nodeId: "pick-plan" });
            return (<Workflow name="approval-selection">
          <Sequence>
            <Approval id="pick-plan" mode="select" output={outputs.selection} request={{ title: "Pick a plan" }} options={[
                    { key: "light", label: "Light" },
                    { key: "balanced", label: "Balanced" },
                ]}/>
            {selection ? (<Task id="record-selection" output={outputs.result}>
                {{ selected: selection.selected }}
              </Task>) : null}
          </Sequence>
        </Workflow>);
        });
        const first = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(first.status).toBe("waiting-approval");
        const adapter = new SmithersDb(db);
        await Effect.runPromise(approveNode(adapter, first.runId, "pick-plan", 0, "balanced is safest", "planner", { selected: "balanced", notes: "balanced is safest" }));
        const resumed = await runInTestRoot(workflow, dbPath, {
            input: {},
            runId: first.runId,
            resume: true,
        });
        expect(resumed.status).toBe("finished");
        const selectionRows = await db.select().from(tables.selection);
        expect(selectionRows).toHaveLength(1);
        expect(selectionRows[0]).toEqual({
            runId: first.runId,
            nodeId: "pick-plan",
            iteration: 0,
            selected: "balanced",
            notes: "balanced is safest",
        });
        const resultRows = await db.select().from(tables.result);
        expect(resultRows[0]?.selected).toBe("balanced");
        cleanup();
    });
    test("ranking approval persists typed ranking output", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            ranking: approvalRankingSchema,
            result: z.object({ first: z.string() }),
        });
        const workflow = smithers((ctx) => {
            const ranking = ctx.outputMaybe("ranking", { nodeId: "rank-plans" });
            return (<Workflow name="approval-ranking">
          <Sequence>
            <Approval id="rank-plans" mode="rank" output={outputs.ranking} request={{ title: "Rank the rollout plans" }} options={[
                    { key: "canary", label: "Canary" },
                    { key: "regional", label: "Regional" },
                    { key: "global", label: "Global" },
                ]}/>
            {ranking ? (<Task id="record-ranking" output={outputs.result}>
                {{ first: ranking.ranked[0] ?? "" }}
              </Task>) : null}
          </Sequence>
        </Workflow>);
        });
        const first = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(first.status).toBe("waiting-approval");
        const adapter = new SmithersDb(db);
        await Effect.runPromise(approveNode(adapter, first.runId, "rank-plans", 0, "canary first", "planner", { ranked: ["canary", "regional", "global"], notes: "canary first" }));
        const resumed = await runInTestRoot(workflow, dbPath, {
            input: {},
            runId: first.runId,
            resume: true,
        });
        expect(resumed.status).toBe("finished");
        const rankingRows = await db.select().from(tables.ranking);
        expect(rankingRows).toHaveLength(1);
        expect(rankingRows[0]).toEqual({
            runId: first.runId,
            nodeId: "rank-plans",
            iteration: 0,
            ranked: ["canary", "regional", "global"],
            notes: "canary first",
        });
        const resultRows = await db.select().from(tables.result);
        expect(resultRows[0]?.first).toBe("canary");
        cleanup();
    });
    test("autoApprove after consecutive manual approvals skips the approval wait", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
            approval: approvalDecisionSchema,
        });
        const workflow = smithers(() => (<Workflow name="approval-auto-approve">
        <Approval id="checkout" output={outputs.approval} request={{ title: "Confirm checkout" }} autoApprove={{ after: 2, audit: true }}/>
      </Workflow>));
        const adapter = new SmithersDb(db);
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const run = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(run.status).toBe("waiting-approval");
            await Effect.runPromise(approveNode(adapter, run.runId, "checkout", 0, "ok", `human-${attempt + 1}`));
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: run.runId,
                resume: true,
            });
            expect(resumed.status).toBe("finished");
        }
        const autoApproved = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(autoApproved.status).toBe("finished");
        const approval = await adapter.getApproval(autoApproved.runId, "checkout", 0);
        expect(approval?.status).toBe("approved");
        expect(approval?.autoApproved).toBe(true);
        const events = await adapter.listEventsByType(autoApproved.runId, "ApprovalAutoApproved");
        expect(events).toHaveLength(1);
        cleanup();
    });
});
