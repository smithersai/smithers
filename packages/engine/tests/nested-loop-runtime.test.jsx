/** @jsxImportSource smithers */
/**
 * Regression tests for https://github.com/jjhub-ai/smithers/issues/117
 *
 * Nested loops are accepted syntactically but runtime state and cache are flat:
 * 1. Inner loop does not restart per outer iteration (state leaks)
 * 2. Loop-owned task reuses cache across iterations
 */
import { describe, expect, test } from "bun:test";
import { Loop, Sequence, Task, Workflow, runWorkflow } from "smithers";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
describe("issue #117 – nested loop runtime scoping", () => {
    test("inner loop resets for each outer iteration", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            outputA: z.object({ value: z.number() }),
            outputB: z.object({ value: z.number() }),
        });
        const workflow = smithers((ctx) => {
            const outerDone = (ctx.latest("outputB", "outerTask")?.value ?? -1) >= 1;
            const innerDone = (ctx.latest("outputA", "innerTask")?.value ?? -1) >= 1;
            return (<Workflow name="nested-loop-mre">
          <Loop id="outer" until={outerDone} maxIterations={3}>
            <Sequence>
              <Loop id="inner" until={innerDone} maxIterations={3}>
                <Task id="innerTask" output={outputs.outputA}>
                  {{ value: ctx.iterations?.["inner"] ?? ctx.iteration }}
                </Task>
              </Loop>
              <Task id="outerTask" output={outputs.outputB}>
                {{ value: ctx.iterations?.["outer"] ?? 0 }}
              </Task>
            </Sequence>
          </Loop>
        </Workflow>);
        });
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "nested-loop-mre" }));
        const innerRows = await db.select().from(tables.outputA);
        // Inner task should be scoped by outer iteration:
        // outer=0: inner runs iterations 0,1  → innerTask@@outer=0:0:0, innerTask@@outer=0:1:1
        // outer=1: inner runs iterations 0,1  → innerTask@@outer=1:0:0, innerTask@@outer=1:1:1
        expect(innerRows
            .map((row) => `${row.nodeId}:${row.iteration}:${row.value}`)
            .sort()).toEqual([
            "innerTask@@outer=0:0:0",
            "innerTask@@outer=0:1:1",
            "innerTask@@outer=1:0:0",
            "innerTask@@outer=1:1:1",
        ]);
        cleanup();
    });
    test("loop-owned task does not reuse cache across iterations", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        let calls = 0;
        const agent = {
            id: "loop-cache-mre",
            tools: {},
            generate: async () => {
                calls += 1;
                return { output: { v: calls } };
            },
        };
        const workflow = smithers((ctx) => (<Workflow name="loop-cache-mre" cache>
        <Loop id="review-loop" until={ctx.iterationCount("out", "review-task") >= 2} maxIterations={3}>
          <Task id="review-task" output={outputs.out} agent={agent}>
            Same prompt
          </Task>
        </Loop>
      </Workflow>));
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "loop-cache-mre" }));
        expect(calls).toBe(2);
        cleanup();
    });
});
