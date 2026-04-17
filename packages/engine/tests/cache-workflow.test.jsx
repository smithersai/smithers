/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
describe("workflow caching", () => {
    test("cache=true reuses output across runs with same prompt", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        let calls = 0;
        const agent = {
            id: "cache-test",
            tools: {},
            generate: async () => { calls++; return { output: { v: calls } }; },
        };
        const workflow = smithers(() => (<Workflow name="cache-reuse" cache>
        <Task id="t" output={outputs.out} agent={agent}>
          Same prompt
        </Task>
      </Workflow>));
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "r1" }));
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "r2" }));
        expect(calls).toBe(1);
        cleanup();
    });
    test("cache=false does not reuse output", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        let calls = 0;
        const agent = {
            id: "no-cache",
            tools: {},
            generate: async () => { calls++; return { output: { v: calls } }; },
        };
        const workflow = smithers(() => (<Workflow name="no-cache">
        <Task id="t" output={outputs.out} agent={agent}>
          Same prompt
        </Task>
      </Workflow>));
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "r1" }));
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "r2" }));
        expect(calls).toBe(2);
        cleanup();
    });
    test("different prompts produce different cache keys", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        let calls = 0;
        const agent = {
            id: "diff-prompt",
            tools: {},
            generate: async () => { calls++; return { output: { v: calls } }; },
        };
        /**
     * @param {string} prompt
     */
        const makeWorkflow = (prompt) => smithers(() => (<Workflow name="diff-cache" cache>
          <Task id="t" output={outputs.out} agent={agent}>
            {prompt}
          </Task>
        </Workflow>));
        await Effect.runPromise(runWorkflow(makeWorkflow("prompt A"), { input: {}, runId: "r1" }));
        await Effect.runPromise(runWorkflow(makeWorkflow("prompt B"), { input: {}, runId: "r2" }));
        expect(calls).toBe(2);
        cleanup();
    });
    test("cache works with static tasks", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="static-cache" cache>
        <Task id="t" output={outputs.out}>
          {{ v: 42 }}
        </Task>
      </Workflow>));
        const r1 = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "r1" }));
        const r2 = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "r2" }));
        expect(r1.status).toBe("finished");
        expect(r2.status).toBe("finished");
        cleanup();
    });
});
