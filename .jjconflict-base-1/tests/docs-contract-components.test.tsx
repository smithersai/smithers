/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Branch,
  Loop,
  Parallel,
  Sequence,
  Task,
  Workflow,
  renderFrame,
  runWorkflow,
} from "../src/index";
import { createTestSmithers, sleep } from "./helpers";
import { outputSchemas } from "./schema";
import { z } from "zod";
import StripExtraFieldsPrompt from "./prompts/docs-contract-components/strip-extra-fields.mdx";
import CachedPrompt from "./prompts/docs-contract-components/cached-prompt.mdx";
import ReturnValuePrompt from "./prompts/docs-contract-components/return-value.mdx";

const TaskAny = Task as any;

describe("docs: <Task>", () => {
  test("compute callbacks run at execution time, not render time", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    let invoked = false;

    const workflow = smithers(() => (
      <Workflow name="compute-timing">
        <Task id="compute" output={outputs.outputA}>
          {() => {
            invoked = true;
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));

    expect(invoked).toBe(false);
    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    expect(invoked).toBe(true);
    cleanup();
  });

  test("static payloads are written directly to the output table", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(
      outputSchemas,
    );

    const workflow = smithers(() => (
      <Workflow name="static-mode">
        <Task id="config" output={outputs.outputA}>
          {{ value: 42 }}
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(42);
    cleanup();
  });

  test("skipIf bypasses the task entirely", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(
      outputSchemas,
    );

    const workflow = smithers(() => (
      <Workflow name="skip-task">
        <Task id="skip" output={outputs.outputA} skipIf>
          {{ value: 1 }}
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(tables.outputA);
    expect(rows.length).toBe(0);
    cleanup();
  });

  test("compute callbacks respect timeoutMs", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);

    const workflow = smithers(() => (
      <Workflow name="compute-timeout">
        <Task id="slow" output={outputs.outputA} timeoutMs={20}>
          {async () => {
            await sleep(200);
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("failed");
    cleanup();
  });

  test("static payloads are validated against the schema", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="static-validate">
        <Task id="bad" output={outputs.output}>
          {{ value: "not-a-number" }}
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("failed");
    cleanup();
  });

  test("schema keys can be referenced by string (docs: output prop)", async () => {
    const { smithers, tables, db, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="string-output">
        <TaskAny id="t" output="output">
          {{ value: 7 }}
        </TaskAny>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(tables.output);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(7);
    cleanup();
  });

  test("outputSchema injects schema into MDX prompt components", async () => {
    const analysisSchema = z.object({ summary: z.string(), risk: z.string() });
    const { smithers, outputs, cleanup } = createTestSmithers({
      analysis: analysisSchema,
    });

    let seenPrompt = "";
    const agent: any = {
      id: "schema-agent",
      tools: {},
      async generate({ prompt }: { prompt: string }) {
        seenPrompt = prompt;
        return { output: { summary: "ok", risk: "low" } };
      },
    };

    function Prompt(props: { schema?: string }) {
      return (
        <>
          Expected schema:
          {"\n"}
          {props.schema}
        </>
      );
    }

    const workflow = smithers(() => (
      <Workflow name="schema-injection">
        <TaskAny
          id="analyze"
          output={outputs.analysis}
          agent={agent}
          outputSchema={analysisSchema}
        >
          <Prompt />
        </TaskAny>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    expect(seenPrompt).toContain("summary");
    expect(seenPrompt).toContain("risk");
    cleanup();
  });

  test("auto-populated columns are stripped from agent output", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    const agent: any = {
      id: "extra-fields",
      tools: {},
      async generate() {
        return {
          output: {
            value: 99,
            runId: "wrong-run",
            nodeId: "wrong-node",
            iteration: 123,
          },
        };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="strip-columns">
        <Task id="strip" output={outputs.output} agent={agent}>
          <StripExtraFieldsPrompt />
        </Task>
      </Workflow>
    ));

    const runId = "strip-run";
    const result = await runWorkflow(workflow, { input: {}, runId });
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(tables.output);
    expect(rows.length).toBe(1);
    expect(rows[0]?.value).toBe(99);
    expect(rows[0]?.runId).toBe(runId);
    expect(rows[0]?.nodeId).toBe("strip");
    expect(rows[0]?.iteration).toBe(0);
    cleanup();
  });
});

describe("docs: <Workflow>", () => {
  test("cache reuses task outputs across runs", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "cache-agent",
      tools: {},
      async generate() {
        calls += 1;
        return { output: { value: calls } };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="cache-workflow" cache>
        <Task id="cached" output={outputs.output} agent={agent}>
          <CachedPrompt />
        </Task>
      </Workflow>
    ));

    const first = await runWorkflow(workflow, { input: {}, runId: "cache-1" });
    expect(first.status).toBe("finished");

    const second = await runWorkflow(workflow, { input: {}, runId: "cache-2" });
    expect(second.status).toBe("finished");
    expect(calls).toBe(1);
    cleanup();
  });

  test("cache key changes when outputSchema changes", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "schema-cache-agent",
      tools: {},
      async generate() {
        calls += 1;
        return { output: { value: calls } };
      },
    };

    const schemaA = z.object({ value: z.number().describe("v1") });
    const schemaB = z.object({ value: z.number().describe("v2") });

    const workflowA = smithers(() => (
      <Workflow name="cache-schema" cache>
        <Task id="cached" output={outputs.output} agent={agent} outputSchema={schemaA}>
          <CachedPrompt />
        </Task>
      </Workflow>
    ));

    const workflowB = smithers(() => (
      <Workflow name="cache-schema" cache>
        <Task id="cached" output={outputs.output} agent={agent} outputSchema={schemaB}>
          <CachedPrompt />
        </Task>
      </Workflow>
    ));

    const first = await runWorkflow(workflowA, { input: {}, runId: "cache-schema-1" });
    expect(first.status).toBe("finished");

    const second = await runWorkflow(workflowB, { input: {}, runId: "cache-schema-2" });
    expect(second.status).toBe("finished");

    expect(calls).toBe(2);
    cleanup();
  });
});

describe("docs: structured output", () => {
  test("schema validation retries agent output up to 2 times", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ value: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "schema-retry",
      tools: {},
      async generate() {
        calls += 1;
        if (calls === 1) {
          return { text: "{\"value\":\"bad\"}" };
        }
        return { text: "{\"value\":1}" };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="schema-retry" cache={false}>
        <Task id="retry" output={outputs.output} agent={agent}>
          <ReturnValuePrompt />
        </Task>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    expect(calls).toBe(2);
    cleanup();
  });
});

describe("docs: control flow components", () => {
  test("<Sequence> skipIf removes all child tasks", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const workflow = smithers(() => (
      <Workflow name="seq-skip">
        <Sequence skipIf>
          <Task id="a" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const snapshot = await renderFrame(workflow, {
      runId: "seq-skip",
      iteration: 0,
      input: {},
      outputs: {},
    });
    expect(snapshot.tasks.length).toBe(0);
    cleanup();
  });

  test("<Parallel> skipIf removes all child tasks", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const workflow = smithers(() => (
      <Workflow name="par-skip">
        <Parallel skipIf>
          <Task id="a" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Parallel>
      </Workflow>
    ));

    const snapshot = await renderFrame(workflow, {
      runId: "par-skip",
      iteration: 0,
      input: {},
      outputs: {},
    });
    expect(snapshot.tasks.length).toBe(0);
    cleanup();
  });

  test("<Branch> skipIf removes both branches", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const workflow = smithers(() => (
      <Workflow name="branch-skip">
        <Branch
          skipIf
          if={true}
          then={
            <Task id="then" output={outputs.outputA}>
              {{ value: 1 }}
            </Task>
          }
          else={
            <Task id="else" output={outputs.outputB}>
              {{ value: 2 }}
            </Task>
          }
        />
      </Workflow>
    ));

    const snapshot = await renderFrame(workflow, {
      runId: "branch-skip",
      iteration: 0,
      input: {},
      outputs: {},
    });
    expect(snapshot.tasks.length).toBe(0);
    cleanup();
  });

  test("<Branch> with no else runs nothing when condition is false", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(
      outputSchemas,
    );

    const workflow = smithers(() => (
      <Workflow name="branch-no-else">
        <Branch
          if={false}
          then={
            <Task id="then" output={outputs.outputA}>
              {{ value: 1 }}
            </Task>
          }
        />
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const rowsA = await (db as any).select().from(tables.outputA);
    expect(rowsA.length).toBe(0);
    cleanup();
  });

  test("<Branch> switches based on completed outputs", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(
      outputSchemas,
    );

    const workflow = smithers((ctx) => (
      <Workflow name="branch-switch">
        <Sequence>
          <Task id="seed" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
          <Branch
            if={ctx.outputMaybe("outputA", { nodeId: "seed" })?.value === 1}
            then={
              <Task id="then" output={outputs.outputB}>
                {{ value: 2 }}
              </Task>
            }
            else={
              <Task id="else" output={outputs.outputC}>
                {{ value: 3 }}
              </Task>
            }
          />
        </Sequence>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const rowsB = await (db as any).select().from(tables.outputB);
    const rowsC = await (db as any).select().from(tables.outputC);
    expect(rowsB.length).toBe(1);
    expect(rowsC.length).toBe(0);
    cleanup();
  });

  test("<Loop> skipIf removes loop children", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const workflow = smithers(() => (
      <Workflow name="loop-skip">
        <Loop id="loop" until={false} skipIf>
          <Task id="step" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Loop>
      </Workflow>
    ));

    const snapshot = await renderFrame(workflow, {
      runId: "loop-skip",
      iteration: 0,
      input: {},
      outputs: {},
    });
    expect(snapshot.tasks.length).toBe(0);
    cleanup();
  });

  test("<Loop> defaults to maxIterations=5 and returns last output", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(
      outputSchemas,
    );

    const workflow = smithers((ctx) => (
      <Workflow name="loop-default-max">
        <Loop id="loop" until={false}>
          <Task id="step" output={outputs.outputA}>
            {{ value: ctx.iteration }}
          </Task>
        </Loop>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(tables.outputA);
    expect(rows.length).toBe(5);
    const iterations = rows
      .map((row: any) => row.iteration)
      .sort((a: number, b: number) => a - b);
    expect(iterations).toEqual([0, 1, 2, 3, 4]);
    cleanup();
  });

  test("<Loop> onMaxReached=fail stops the workflow", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);

    const workflow = smithers(() => (
      <Workflow name="loop-fail">
        <Loop id="loop" until={false} onMaxReached="fail" maxIterations={2}>
          <Task id="step" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Loop>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("failed");
    cleanup();
  });

  test("<Loop> exposes ctx.iteration and ctx.iterations", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      loopOutput: z.object({ iter: z.number() }),
      afterOutput: z.object({ mapValue: z.number() }),
    });

    const workflow = smithers((ctx) => (
      <Workflow name="loop-ctx">
        <Sequence>
          <Loop id="review-loop" until={ctx.outputs("loopOutput").length >= 3}>
            <Task id="step" output={outputs.loopOutput}>
              {{ iter: ctx.iteration }}
            </Task>
          </Loop>
          <Task id="after" output={outputs.afterOutput}>
            {{ mapValue: ctx.iterations?.["review-loop"] ?? -1 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const loopRows = await (db as any).select().from(tables.loopOutput);
    const byIter = loopRows.sort((a: any, b: any) => a.iteration - b.iteration);
    expect(byIter.length).toBe(3);
    expect(byIter[0].iter).toBe(0);
    expect(byIter[1].iter).toBe(1);
    expect(byIter[2].iter).toBe(2);

    const afterRows = await (db as any).select().from(tables.afterOutput);
    expect(afterRows[0]?.mapValue).toBe(2);
    cleanup();
  });

  test("ctx.iterationCount counts completed iterations", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      output: z.object({ count: z.number(), iter: z.number() }),
    });

    const workflow = smithers((ctx) => (
      <Workflow name="loop-iteration-count">
        <Loop
          id="count-loop"
          until={ctx.iterationCount("output", "step") >= 2}
          maxIterations={5}
        >
          <Task id="step" output={outputs.output}>
            {{
              count: ctx.iterationCount("output", "step"),
              iter: ctx.iteration,
            }}
          </Task>
        </Loop>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(tables.output);
    const counts = rows
      .map((row: any) => row.count)
      .sort((a: number, b: number) => a - b);
    expect(counts).toEqual([0, 1]);
    cleanup();
  });
});
