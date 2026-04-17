/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, Parallel, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
describe("concurrent workflow safety", () => {
    test("two independent runs complete without interference", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="concurrent">
        <Task id="t" output={outputs.out}>
          {async () => {
                await sleep(20);
                return { v: Math.floor(Math.random() * 1000) };
            }}
        </Task>
      </Workflow>));
        const [r1, r2] = await Promise.all([
            Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "run-1" })),
            Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "run-2" })),
        ]);
        expect(r1.status).toBe("finished");
        expect(r2.status).toBe("finished");
        expect(r1.runId).toBe("run-1");
        expect(r2.runId).toBe("run-2");
        const rows = db.select().from(tables.out).all();
        expect(rows.length).toBe(2);
        const runIds = rows.map((r) => r.runId).sort();
        expect(runIds).toEqual(["run-1", "run-2"]);
        cleanup();
    });
    test("parallel tasks don't exceed maxConcurrency globally", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        let current = 0;
        let peak = 0;
        const maxC = 3;
        const workflow = smithers(() => (<Workflow name="global-concurrency">
        <Parallel>
          {Array.from({ length: 8 }, (_, i) => (<Task key={`t${i}`} id={`t${i}`} output={outputs.out}>
              {async () => {
                    current++;
                    if (current > peak)
                        peak = current;
                    await sleep(30);
                    current--;
                    return { v: i };
                }}
            </Task>))}
        </Parallel>
      </Workflow>));
        const r = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            maxConcurrency: maxC,
        }));
        expect(r.status).toBe("finished");
        expect(peak).toBeLessThanOrEqual(maxC);
        cleanup();
    });
    test("maxConcurrency=1 serializes all tasks", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        let maxConcurrent = 0;
        let active = 0;
        const workflow = smithers(() => (<Workflow name="serial">
        <Parallel>
          {Array.from({ length: 4 }, (_, i) => (<Task key={`t${i}`} id={`t${i}`} output={outputs.out}>
              {async () => {
                    active++;
                    if (active > maxConcurrent)
                        maxConcurrent = active;
                    await sleep(10);
                    active--;
                    return { v: i };
                }}
            </Task>))}
        </Parallel>
      </Workflow>));
        const r = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 1 }));
        expect(r.status).toBe("finished");
        expect(maxConcurrent).toBe(1);
        cleanup();
    });
});
