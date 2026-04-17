/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Saga, TryCatchFinally, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "./helpers.js";
import { z } from "zod";
import { Effect } from "effect";
const COMPONENT_TIMEOUT_MS = 30_000;
/**
 * @param {string} name
 * @param {() => Promise<unknown>} fn
 */
function workflowTest(name, fn) {
    test(name, fn, COMPONENT_TIMEOUT_MS);
}
describe("TryCatchFinally", () => {
    workflowTest("happy path runs try and finally, skipping catch", async () => {
        const { Workflow, Task, Sequence, smithers, outputs, tables, db, cleanup, } = createTestSmithers({
            tryResult: z.object({ stage: z.string() }),
            catchResult: z.object({ recovered: z.boolean() }),
            finallyResult: z.object({ cleanedUp: z.boolean() }),
        });
        const workflow = smithers(() => (<Workflow name="try-catch-finally-happy">
        <TryCatchFinally try={<Sequence>
              <Task id="do-work" output={outputs.tryResult}>
                {{ stage: "completed" }}
              </Task>
            </Sequence>} catch={<Task id="recover" output={outputs.catchResult}>
              {{ recovered: true }}
            </Task>} finally={<Task id="cleanup" output={outputs.finallyResult}>
              {{ cleanedUp: true }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const tryRows = db.select().from(tables.tryResult).all();
        const catchRows = db.select().from(tables.catchResult).all();
        const finallyRows = db.select().from(tables.finallyResult).all();
        expect(tryRows.length).toBe(1);
        expect(tryRows[0].stage).toBe("completed");
        expect(catchRows.length).toBe(0);
        expect(finallyRows.length).toBe(1);
        expect(finallyRows[0].cleanedUp).toBe(true);
        cleanup();
    });
    workflowTest("failure path runs catch and finally", async () => {
        const { Workflow, Task, Sequence, smithers, outputs, tables, db, cleanup, } = createTestSmithers({
            tryResult: z.object({ stage: z.string() }),
            catchResult: z.object({ recovered: z.boolean(), reason: z.string() }),
            finallyResult: z.object({ cleanedUp: z.boolean() }),
        });
        const workflow = smithers(() => (<Workflow name="try-catch-finally-failure">
        <TryCatchFinally try={<Sequence>
              <Task id="explode" output={outputs.tryResult} noRetry>
                {() => {
                    throw new Error("boom");
                }}
              </Task>
            </Sequence>} catch={<Task id="recover" output={outputs.catchResult}>
              {{ recovered: true, reason: "fallback" }}
            </Task>} finally={<Task id="cleanup" output={outputs.finallyResult}>
              {{ cleanedUp: true }}
            </Task>}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const tryRows = db.select().from(tables.tryResult).all();
        const catchRows = db.select().from(tables.catchResult).all();
        const finallyRows = db.select().from(tables.finallyResult).all();
        expect(tryRows.length).toBe(0);
        expect(catchRows.length).toBe(1);
        expect(catchRows[0].recovered).toBe(true);
        expect(catchRows[0].reason).toBe("fallback");
        expect(finallyRows.length).toBe(1);
        expect(finallyRows[0].cleanedUp).toBe(true);
        cleanup();
    });
});
describe("Saga", () => {
    workflowTest("happy path completes actions without compensation", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup, } = createTestSmithers({
            reservation: z.object({ resource: z.string() }),
            payment: z.object({ charged: z.boolean() }),
            compensation: z.object({ step: z.string() }),
        });
        const workflow = smithers(() => (<Workflow name="saga-happy">
        <Saga steps={[
                {
                    id: "reserve",
                    action: (<Task id="reserve-resource" output={outputs.reservation}>
                  {{ resource: "inventory" }}
                </Task>),
                    compensation: (<Task id="release-resource" output={outputs.compensation}>
                  {{ step: "reserve" }}
                </Task>),
                },
                {
                    id: "charge",
                    action: (<Task id="charge-card" output={outputs.payment}>
                  {{ charged: true }}
                </Task>),
                    compensation: (<Task id="refund-card" output={outputs.compensation}>
                  {{ step: "charge" }}
                </Task>),
                },
            ]}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const reservationRows = db.select().from(tables.reservation).all();
        const paymentRows = db.select().from(tables.payment).all();
        const compensationRows = db.select().from(tables.compensation).all();
        expect(reservationRows.length).toBe(1);
        expect(paymentRows.length).toBe(1);
        expect(compensationRows.length).toBe(0);
        cleanup();
    });
    workflowTest("failure path compensates completed steps in reverse order", async () => {
        const { Workflow, Task, smithers, outputs, tables, db, cleanup, } = createTestSmithers({
            reservation: z.object({ resource: z.string() }),
            payment: z.object({ charged: z.boolean() }),
            compensation: z.object({ step: z.string() }),
        });
        const workflow = smithers(() => (<Workflow name="saga-compensate">
        <Saga steps={[
                {
                    id: "reserve",
                    action: (<Task id="reserve-resource" output={outputs.reservation}>
                  {{ resource: "inventory" }}
                </Task>),
                    compensation: (<Task id="release-resource" output={outputs.compensation}>
                  {{ step: "reserve" }}
                </Task>),
                },
                {
                    id: "charge",
                    action: (<Task id="charge-card" output={outputs.payment} noRetry>
                  {() => {
                            throw new Error("payment failed");
                        }}
                </Task>),
                    compensation: (<Task id="refund-card" output={outputs.compensation}>
                  {{ step: "charge" }}
                </Task>),
                },
            ]}/>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const reservationRows = db.select().from(tables.reservation).all();
        const paymentRows = db.select().from(tables.payment).all();
        const compensationRows = db
            .select()
            .from(tables.compensation)
            .all();
        expect(reservationRows.length).toBe(1);
        expect(paymentRows.length).toBe(0);
        expect(compensationRows.length).toBe(1);
        expect(compensationRows[0].step).toBe("reserve");
        cleanup();
    });
});
