/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Parallel, Ralph, Sequence, Task, Workflow, runWorkflow, smithers } from "../src/index.ts";
import { approveNode } from "../src/engine/approvals";
import { SmithersDb } from "../src/db/adapter";
import { createTestDb, sleep } from "./helpers";
import { ddl, outputA, outputB, outputC, schema } from "./schema";

function buildDb() {
  return createTestDb(schema, ddl);
}

describe("Ralph iteration", () => {
  test("iterates until condition met", async () => {
    const { db, cleanup } = buildDb();
    const workflow = smithers(db as any, (ctx) => (
      <Workflow name="loop">
        <Ralph id="loop" until={ctx.outputs(outputA).length >= 2}>
          <Task id="step" output={outputA}>
            {{ value: ctx.outputs(outputA).length }}
          </Task>
        </Ralph>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(outputA);
    const iterations = rows.map((row: any) => row.iteration).sort((a: number, b: number) => a - b);
    expect(iterations).toEqual([0, 1]);
    cleanup();
  });

  test("multiple Ralph loops are independent", async () => {
    const { db, cleanup } = buildDb();
    const workflow = smithers(db as any, (ctx) => (
      <Workflow name="multi">
        <Sequence>
          <Ralph id="loopA" until={ctx.outputs(outputA).length >= 2}>
            <Task id="taskA" output={outputA}>
              {{ value: ctx.outputs(outputA).length }}
            </Task>
          </Ralph>
          <Ralph id="loopB" until={ctx.outputs(outputB).length >= 1}>
            <Task id="taskB" output={outputB}>
              {{ value: ctx.outputs(outputB).length }}
            </Task>
          </Ralph>
        </Sequence>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const rowsA = await (db as any).select().from(outputA);
    const rowsB = await (db as any).select().from(outputB);
    const iterationsA = rowsA.map((row: any) => row.iteration).sort((a: number, b: number) => a - b);
    const iterationsB = rowsB.map((row: any) => row.iteration).sort((a: number, b: number) => a - b);
    expect(iterationsA).toEqual([0, 1]);
    expect(iterationsB).toEqual([0]);
    cleanup();
  });

  test("nested Ralph throws", async () => {
    const { db, cleanup } = buildDb();
    const workflow = smithers(db as any, (_ctx) => (
      <Workflow name="nested">
        <Ralph id="outer" until={false}>
          <Ralph id="inner" until={true}>
            <Task id="innerTask" output={outputA}>
              {{ value: 1 }}
            </Task>
          </Ralph>
        </Ralph>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("failed");
    cleanup();
  });
});

describe("Parallel concurrency", () => {
  test("respects maxConcurrency", async () => {
    const { db, cleanup } = buildDb();
    let current = 0;
    let max = 0;

    const agent: any = {
      id: "fake",
      tools: {},
      generate: async ({ prompt }: { prompt: string }) => {
        current += 1;
        if (current > max) max = current;
        await sleep(50);
        current -= 1;
        const value = Number((prompt ?? "").split(":")[1] ?? 0);
        return { output: { value } };
      },
    };

    const workflow = smithers(db as any, (_ctx) => (
      <Workflow name="parallel">
        <Parallel maxConcurrency={2}>
          {Array.from({ length: 5 }, (_, i) => (
            <Task key={`p${i}`} id={`p${i}`} output={outputC} agent={agent}>
              {`v:${i}`}
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {}, maxConcurrency: 4 });
    expect(result.status).toBe("finished");
    expect(max).toBeLessThanOrEqual(2);
    cleanup();
  });
});

describe("Approvals", () => {
  test("needsApproval pauses and resumes", async () => {
    const { db, cleanup } = buildDb();
    const workflow = smithers(db as any, (_ctx) => (
      <Workflow name="approval">
        <Sequence>
          <Task id="gate" output={outputA} needsApproval>
            {{ value: 1 }}
          </Task>
          <Task id="after" output={outputB}>
            {{ value: 2 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const first = await runWorkflow(workflow, { input: {} });
    expect(first.status).toBe("waiting-approval");

    const adapter = new SmithersDb(db as any);
    await approveNode(adapter, first.runId, "gate", 0, "ok", "test");

    const resumed = await runWorkflow(workflow, { input: {}, runId: first.runId, resume: true });
    expect(resumed.status).toBe("finished");

    const rowsB = await (db as any).select().from(outputB);
    expect(rowsB.length).toBe(1);
    cleanup();
  });
});

describe("Renderer safeguards", () => {
  test("duplicate task ids fail the run", async () => {
    const { db, cleanup } = buildDb();
    const workflow = smithers(db as any, (_ctx) => (
      <Workflow name="dup">
        <Sequence>
          <Task id="dup" output={outputA}>
            {{ value: 1 }}
          </Task>
          <Task id="dup" output={outputB}>
            {{ value: 2 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("failed");
    cleanup();
  });
});
