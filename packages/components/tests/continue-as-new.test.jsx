/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb, runWorkflow } from "smithers";
import { createTestSmithers } from "./helpers.js";
describe("continue-as-new", () => {
    test("splits long loop runs, carries state, and preserves ancestry", async () => {
        const { smithers, outputs, Workflow, Loop, Task, db, tables, cleanup, } = createTestSmithers({
            tick: z.object({
                count: z.number(),
                observedBefore: z.number(),
            }),
        });
        const workflow = smithers((ctx) => {
            const ticks = ctx.outputs("tick");
            const done = ticks.length >= 12;
            return (<Workflow name="continue-loop">
          <Loop id="daemon" until={done} maxIterations={200} continueAsNewEvery={5}>
            <Task id="tick" output={outputs.tick}>
              {() => ({
                    count: ticks.length + 1,
                    observedBefore: ticks.length,
                })}
            </Task>
          </Loop>
        </Workflow>);
        });
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const adapter = new SmithersDb(db);
        const ancestry = await adapter.listRunAncestry(result.runId, 100);
        expect(ancestry.length).toBe(3);
        const run3Id = ancestry[0].runId;
        const run2Id = ancestry[1].runId;
        const run1Id = ancestry[2].runId;
        const run1 = await adapter.getRun(run1Id);
        const run2 = await adapter.getRun(run2Id);
        const run3 = await adapter.getRun(run3Id);
        expect(run1?.status).toBe("continued");
        expect(run2?.status).toBe("continued");
        expect(run3?.status).toBe("finished");
        expect(run2?.parentRunId).toBe(run1Id);
        expect(run3?.parentRunId).toBe(run2Id);
        const run1Rows = db
            .select()
            .from(tables.tick)
            .where(eq(tables.tick.runId, run1Id))
            .all();
        const run2Rows = db
            .select()
            .from(tables.tick)
            .where(eq(tables.tick.runId, run2Id))
            .all();
        const run3Rows = db
            .select()
            .from(tables.tick)
            .where(eq(tables.tick.runId, run3Id))
            .all();
        expect(run1Rows.length).toBe(5);
        expect(run2Rows.length).toBe(10);
        expect(run3Rows.length).toBe(12);
        expect(run2Rows.find((row) => row.iteration === 5)?.observedBefore).toBe(5);
        const run2Attempts = await Effect.runPromise(adapter.listAttemptsForRun(run2Id));
        const run3Attempts = await Effect.runPromise(adapter.listAttemptsForRun(run3Id));
        expect(run2Attempts.filter((a) => a.nodeId === "tick").length).toBe(5);
        expect(run3Attempts.filter((a) => a.nodeId === "tick").length).toBe(2);
        const run1Events = await adapter.listEvents(run1Id, -1, 5_000);
        expect(run1Events.some((event) => event.type === "RunContinuedAsNew")).toBe(true);
        const run1Node = await adapter.getNode(run1Id, "tick", 0);
        expect(run1Node?.state).toBe("finished");
        cleanup();
    });
    test("supports explicit continue-as-new with workflow payload", async () => {
        const { smithers, outputs, Workflow, Sequence, Task, ContinueAsNew, db, tables, cleanup, } = createTestSmithers({
            result: z.object({
                cursor: z.string().nullable(),
                seenPayload: z.boolean(),
            }),
        });
        const workflow = smithers((ctx) => {
            const continuation = ctx.input?.__smithersContinuation;
            const shouldContinue = !continuation?.payload;
            return (<Workflow name="explicit-continue">
          <Sequence>
            {shouldContinue ? <ContinueAsNew state={{ cursor: "abc" }}/> : null}
            <Task id="result" output={outputs.result}>
              {() => ({
                    cursor: continuation?.payload?.cursor ?? null,
                    seenPayload: Boolean(continuation?.payload),
                })}
            </Task>
          </Sequence>
        </Workflow>);
        });
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const adapter = new SmithersDb(db);
        const ancestry = await adapter.listRunAncestry(result.runId, 100);
        expect(ancestry.length).toBe(2);
        const latestRunId = ancestry[0].runId;
        const previousRunId = ancestry[1].runId;
        const previousRun = await adapter.getRun(previousRunId);
        expect(previousRun?.status).toBe("continued");
        const resultRows = db
            .select()
            .from(tables.result)
            .where(eq(tables.result.runId, latestRunId))
            .all();
        expect(resultRows.length).toBe(1);
        expect(resultRows[0].cursor).toBe("abc");
        expect(resultRows[0].seenPayload).toBe(true);
        const previousEvents = await adapter.listEvents(previousRunId, -1, 100);
        expect(previousEvents.some((event) => event.type === "RunContinuedAsNew")).toBe(true);
        cleanup();
    });
});
