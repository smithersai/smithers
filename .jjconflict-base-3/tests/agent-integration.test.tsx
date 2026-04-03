/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, Sequence, runWorkflow } from "../src/index";
import { createTestSmithers, sleep } from "./helpers";
import { z } from "zod";

function fakeAgent(response: any, opts?: { delay?: number }) {
  return {
    id: "fake-agent",
    tools: {},
    generate: async () => {
      if (opts?.delay) await sleep(opts.delay);
      return { output: response };
    },
  } as any;
}

function failingAgent(failCount: number, successResponse: any) {
  let calls = 0;
  return {
    id: "failing-agent",
    tools: {},
    generate: async () => {
      calls++;
      if (calls <= failCount) throw new Error(`fail ${calls}`);
      return { output: successResponse };
    },
    get callCount() { return calls; },
  } as any;
}

function textAgent(text: string) {
  return {
    id: "text-agent",
    tools: {},
    generate: async () => ({ text }),
  } as any;
}

describe("agent task execution", () => {
  test("agent output is persisted to db", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      result: z.object({ answer: z.string() }),
    });

    const agent = fakeAgent({ answer: "42" });
    const workflow = smithers(() => (
      <Workflow name="agent-basic">
        <Task id="ask" output={outputs.result} agent={agent}>
          What is the meaning of life?
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.result).all();
    expect(rows[0].answer).toBe("42");
    cleanup();
  });

  test("agent task retries on failure and succeeds", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      result: z.object({ value: z.number() }),
    });

    const agent = failingAgent(2, { value: 99 });
    const workflow = smithers(() => (
      <Workflow name="agent-retry">
        <Task id="flaky" output={outputs.result} agent={agent} retries={3}>
          Do the thing.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.result).all();
    expect(rows[0].value).toBe(99);
    cleanup();
  });

  test("agent task fails when retries exhausted", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      result: z.object({ value: z.number() }),
    });

    const agent = failingAgent(10, { value: 1 });
    const workflow = smithers(() => (
      <Workflow name="agent-fail">
        <Task id="doomed" output={outputs.result} agent={agent} retries={2}>
          Try.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("failed");
    cleanup();
  });

  test("agent text response is parsed as JSON", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      result: z.object({ name: z.string() }),
    });

    const agent = textAgent('{"name": "smithers"}');
    const workflow = smithers(() => (
      <Workflow name="agent-text">
        <Task id="parse" output={outputs.result} agent={agent}>
          Give me a name.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.result).all();
    expect(rows[0].name).toBe("smithers");
    cleanup();
  });

  test("agent in sequence uses previous output via context", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      first: z.object({ topic: z.string() }),
      second: z.object({ analysis: z.string() }),
    });

    let receivedPrompt = "";
    const agent: any = {
      id: "context-agent",
      tools: {},
      generate: async ({ prompt }: any) => {
        receivedPrompt = prompt;
        return { output: { analysis: "good" } };
      },
    };

    const workflow = smithers((ctx) => (
      <Workflow name="agent-chain">
        <Sequence>
          <Task id="first" output={outputs.first}>
            {{ topic: "testing" }}
          </Task>
          <Task id="second" output={outputs.second} agent={agent}>
            {`Analyze: ${ctx.outputMaybe("first", { nodeId: "first" })?.topic ?? "unknown"}`}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(receivedPrompt).toContain("testing");
    cleanup();
  });

  test("agent with fallbackAgent uses fallback on primary failure", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      result: z.object({ value: z.number() }),
    });

    const primary = failingAgent(5, { value: 1 });
    const fallback = fakeAgent({ value: 42 });

    const workflow = smithers(() => (
      <Workflow name="agent-fallback">
        <Task
          id="with-fallback"
          output={outputs.result}
          agent={primary}
          fallbackAgent={fallback}
          retries={1}
        >
          Do it.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.result).all();
    expect(rows[0].value).toBe(42);
    cleanup();
  });

  test("agent auto-strips system columns from output", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      result: z.object({ value: z.number() }),
    });

    const agent = fakeAgent({
      value: 7,
      runId: "should-be-stripped",
      nodeId: "should-be-stripped",
      iteration: 999,
    });

    const workflow = smithers(() => (
      <Workflow name="strip-test">
        <Task id="strip" output={outputs.result} agent={agent}>
          Go.
        </Task>
      </Workflow>
    ));

    const runId = "strip-run-id";
    const r = await runWorkflow(workflow, { input: {}, runId });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.result).all();
    expect(rows[0].value).toBe(7);
    expect(rows[0].runId).toBe(runId);
    expect(rows[0].nodeId).toBe("strip");
    expect(rows[0].iteration).toBe(0);
    cleanup();
  });

  test("agent receives prompt text from JSX children", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      result: z.object({ value: z.number() }),
    });

    let capturedPrompt = "";
    const agent: any = {
      id: "prompt-capture",
      tools: {},
      generate: async ({ prompt }: any) => {
        capturedPrompt = prompt;
        return { output: { value: 1 } };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="prompt-test">
        <Task id="t" output={outputs.result} agent={agent}>
          Hello world, this is a test prompt.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(capturedPrompt).toContain("Hello world, this is a test prompt.");
    cleanup();
  });
});
