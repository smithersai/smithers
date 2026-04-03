/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, runWorkflow } from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

describe("workflow caching", () => {
  test("cache=true reuses output across runs with same prompt", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "cache-test",
      tools: {},
      generate: async () => { calls++; return { output: { v: calls } }; },
    };

    const workflow = smithers(() => (
      <Workflow name="cache-reuse" cache>
        <Task id="t" output={outputs.out} agent={agent}>
          Same prompt
        </Task>
      </Workflow>
    ));

    await runWorkflow(workflow, { input: {}, runId: "r1" });
    await runWorkflow(workflow, { input: {}, runId: "r2" });
    expect(calls).toBe(1);
    cleanup();
  });

  test("cache=false does not reuse output", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "no-cache",
      tools: {},
      generate: async () => { calls++; return { output: { v: calls } }; },
    };

    const workflow = smithers(() => (
      <Workflow name="no-cache">
        <Task id="t" output={outputs.out} agent={agent}>
          Same prompt
        </Task>
      </Workflow>
    ));

    await runWorkflow(workflow, { input: {}, runId: "r1" });
    await runWorkflow(workflow, { input: {}, runId: "r2" });
    expect(calls).toBe(2);
    cleanup();
  });

  test("different prompts produce different cache keys", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "diff-prompt",
      tools: {},
      generate: async () => { calls++; return { output: { v: calls } }; },
    };

    const makeWorkflow = (prompt: string) =>
      smithers(() => (
        <Workflow name="diff-cache" cache>
          <Task id="t" output={outputs.out} agent={agent}>
            {prompt}
          </Task>
        </Workflow>
      ));

    await runWorkflow(makeWorkflow("prompt A"), { input: {}, runId: "r1" });
    await runWorkflow(makeWorkflow("prompt B"), { input: {}, runId: "r2" });
    expect(calls).toBe(2);
    cleanup();
  });

  test("cache works with static tasks", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="static-cache" cache>
        <Task id="t" output={outputs.out}>
          {{ v: 42 }}
        </Task>
      </Workflow>
    ));

    const r1 = await runWorkflow(workflow, { input: {}, runId: "r1" });
    const r2 = await runWorkflow(workflow, { input: {}, runId: "r2" });
    expect(r1.status).toBe("finished");
    expect(r2.status).toBe("finished");
    cleanup();
  });
});
