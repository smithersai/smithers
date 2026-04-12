/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Parallel,
  Ralph,
  Sequence,
  Task,
  Workflow,
  runWorkflow,
} from "smithers";
import { approveNode } from "../src/approvals";
import { SmithersDb } from "@smithers/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers";
import { outputSchemas } from "../../smithers/tests/schema";
import { Effect } from "effect";

function buildSmithers() {
  return createTestSmithers(outputSchemas);
}

describe("Ralph iteration", () => {
  test("iterates until condition met", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((ctx) => (
      <Workflow name="loop">
        <Ralph id="loop" until={ctx.outputs("outputA").length >= 2}>
          <Task id="step" output={outputs.outputA}>
            {{ value: ctx.outputs("outputA").length }}
          </Task>
        </Ralph>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(tables.outputA);
    const iterations = rows
      .map((row: any) => row.iteration)
      .sort((a: number, b: number) => a - b);
    expect(iterations).toEqual([0, 1]);
    cleanup();
  });

  test("multiple Ralph loops are independent", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((ctx) => (
      <Workflow name="multi">
        <Sequence>
          <Ralph id="loopA" until={ctx.outputs("outputA").length >= 2}>
            <Task id="taskA" output={outputs.outputA}>
              {{ value: ctx.outputs("outputA").length }}
            </Task>
          </Ralph>
          <Ralph id="loopB" until={ctx.outputs("outputB").length >= 1}>
            <Task id="taskB" output={outputs.outputB}>
              {{ value: ctx.outputs("outputB").length }}
            </Task>
          </Ralph>
        </Sequence>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");

    const rowsA = await (db as any).select().from(tables.outputA);
    const rowsB = await (db as any).select().from(tables.outputB);
    const iterationsA = rowsA
      .map((row: any) => row.iteration)
      .sort((a: number, b: number) => a - b);
    const iterationsB = rowsB
      .map((row: any) => row.iteration)
      .sort((a: number, b: number) => a - b);
    expect(iterationsA).toEqual([0, 1]);
    expect(iterationsB).toEqual([0]);
    cleanup();
  });

  test("nested Ralph throws", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="nested">
        <Ralph id="outer" until={false}>
          <Ralph id="inner" until={true}>
            <Task id="innerTask" output={outputs.outputA}>
              {{ value: 1 }}
            </Task>
          </Ralph>
        </Ralph>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    cleanup();
  });
});

describe("Parallel concurrency", () => {
  test("respects maxConcurrency", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    let current = 0;
    let max = 0;

    const agent: any = {
      id: "fake",
      tools: {},
      generate: async () => {
        current += 1;
        if (current > max) max = current;
        await sleep(50);
        current -= 1;
        return { output: { value: 1 } };
      },
    };

    const workflow = smithers((_ctx) => (
      <Workflow name="parallel">
        <Parallel maxConcurrency={2}>
          {Array.from({ length: 5 }, (_, i) => (
            <Task key={`p${i}`} id={`p${i}`} output={outputs.outputC} agent={agent}>
              run task
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, {
      input: {},
      maxConcurrency: 4,
    }));
    expect(result.status).toBe("finished");
    expect(max).toBeLessThanOrEqual(2);
    cleanup();
  });
});

describe("Approvals", () => {
  test("needsApproval pauses and resumes", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="approval">
        <Sequence>
          <Task id="gate" output={outputs.outputA} needsApproval>
            {{ value: 1 }}
          </Task>
          <Task id="after" output={outputs.outputB}>
            {{ value: 2 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(first.status).toBe("waiting-approval");

    const adapter = new SmithersDb(db as any);
    await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "ok", "test"));

    const resumed = await Effect.runPromise(runWorkflow(workflow, {
      input: {},
      runId: first.runId,
      resume: true,
    }));
    expect(resumed.status).toBe("finished");

    const rowsB = await (db as any).select().from(tables.outputB);
    expect(rowsB.length).toBe(1);
    cleanup();
  });
});

describe("Compute callback children", () => {
  test("sync callback is invoked and result written to db", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-sync">
        <Task id="calc" output={outputs.outputA}>
          {() => ({ value: 40 + 2 })}
        </Task>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(42);
    cleanup();
  });

  test("async callback is awaited and result written to db", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-async">
        <Task id="calc" output={outputs.outputA}>
          {async () => {
            await sleep(10);
            return { value: 99 };
          }}
        </Task>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(99);
    cleanup();
  });

  test("callback that throws fails the task", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-fail">
        <Task id="calc" output={outputs.outputA} noRetry>
          {() => { throw new Error("compute boom"); }}
        </Task>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    cleanup();
  });

  test("callback respects timeoutMs", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-timeout">
        <Task id="slow" output={outputs.outputA} timeoutMs={50} noRetry>
          {async () => {
            await sleep(500);
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    cleanup();
  });

  test("callback retries on failure", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) throw new Error("not yet");
      return { value: calls };
    };

    const workflow = smithers((_ctx) => (
      <Workflow name="compute-retry">
        <Task id="retryable" output={outputs.outputA} retries={2}>
          {fn}
        </Task>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(calls).toBe(3);

    const rows = await (db as any).select().from(tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(3);
    cleanup();
  });

  test("callback with continueOnFail does not fail workflow", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-continue">
        <Sequence>
          <Task id="bomb" output={outputs.outputA} continueOnFail noRetry>
            {() => { throw new Error("boom"); }}
          </Task>
          <Task id="after" output={outputs.outputB}>
            {{ value: 42 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");

    const rowsB = await (db as any).select().from(tables.outputB);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0].value).toBe(42);
    cleanup();
  });

  test("callback in a sequence works with static tasks", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-sequence">
        <Sequence>
          <Task id="first" output={outputs.outputA}>
            {() => ({ value: 10 })}
          </Task>
          <Task id="second" output={outputs.outputB}>
            {{ value: 20 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");

    const rowsA = await (db as any).select().from(tables.outputA);
    const rowsB = await (db as any).select().from(tables.outputB);
    expect(rowsA[0].value).toBe(10);
    expect(rowsB[0].value).toBe(20);
    cleanup();
  });
});

describe("Renderer safeguards", () => {
  test("duplicate task ids fail the run", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="dup">
        <Sequence>
          <Task id="dup" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
          <Task id="dup" output={outputs.outputB}>
            {{ value: 2 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    cleanup();
  });
});
