/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Sequence,
  Parallel,
  Workflow,
  Task,
  Branch,
  Ralph,
  runWorkflow,
} from "../src/index";
import { createTestSmithers, sleep } from "./helpers";
import { z } from "zod";

describe("createSmithers", () => {
  test("creates tables from Zod schemas automatically", () => {
    const { tables, db, cleanup } = createTestSmithers({
      tasks: z.object({ title: z.string(), priority: z.number() }),
    });

    (db as any).insert(tables.tasks).values({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      title: "test",
      priority: 1,
    }).run();

    const rows = (db as any).select().from(tables.tasks).all();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe("test");
    cleanup();
  });

  test("outputs keys match schema keys", () => {
    const { outputs, cleanup } = createTestSmithers({
      alpha: z.object({ v: z.number() }),
      beta: z.object({ s: z.string() }),
    });

    expect(outputs).toHaveProperty("alpha");
    expect(outputs).toHaveProperty("beta");
    cleanup();
  });

  test("smithers builder produces a runnable workflow", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      result: z.object({ sum: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="basic">
        <Task id="add" output={outputs.result}>
          {{ sum: 1 + 2 }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.result).all();
    expect(rows[0].sum).toBe(3);
    cleanup();
  });

  test("reserved input schema is validated via ctx.input without shadowing the input table", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      input: z.object({ prompt: z.string() }),
      result: z.object({ echoedPrompt: z.string() }),
    });

    const workflow = smithers((ctx) => (
      <Workflow name="input-schema">
        <Task id="echo" output={outputs.result}>
          {{ echoedPrompt: ctx.input.prompt }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: { prompt: "hello" } });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.result).all();
    expect(rows[0].echoedPrompt).toBe("hello");
    cleanup();
  });
});

describe("workflow control flow integration", () => {
  test("sequence executes tasks in order", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ step: z.number() }),
    });

    const order: number[] = [];
    const workflow = smithers(() => (
      <Workflow name="seq-order">
        <Sequence>
          <Task id="a" output={outputs.output}>
            {() => { order.push(1); return { step: 1 }; }}
          </Task>
          <Task id="b" output={outputs.output}>
            {() => { order.push(2); return { step: 2 }; }}
          </Task>
          <Task id="c" output={outputs.output}>
            {() => { order.push(3); return { step: 3 }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(order).toEqual([1, 2, 3]);
    cleanup();
  });

  test("parallel executes tasks concurrently", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      output: z.object({ v: z.number() }),
    });

    let peak = 0;
    let active = 0;
    const workflow = smithers(() => (
      <Workflow name="par-test">
        <Parallel>
          {[1, 2, 3].map((i) => (
            <Task key={`t${i}`} id={`t${i}`} output={outputs.output}>
              {async () => {
                active++;
                if (active > peak) peak = active;
                await sleep(30);
                active--;
                return { v: i };
              }}
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {}, maxConcurrency: 10 });
    expect(r.status).toBe("finished");
    expect(peak).toBeGreaterThan(1);
    cleanup();
  });

  test("branch takes else path when condition is false", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      a: z.object({ v: z.number() }),
      b: z.object({ v: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="branch-else">
        <Branch
          if={false}
          then={<Task id="then" output={outputs.a}>{{ v: 1 }}</Task>}
          else={<Task id="else" output={outputs.b}>{{ v: 2 }}</Task>}
        />
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rowsA = (db as any).select().from(tables.a).all();
    const rowsB = (db as any).select().from(tables.b).all();
    expect(rowsA.length).toBe(0);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0].v).toBe(2);
    cleanup();
  });

  test("loop terminates when until becomes true", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      counter: z.object({ n: z.number() }),
    });

    const workflow = smithers((ctx) => (
      <Workflow name="loop-until">
        <Ralph id="loop" until={ctx.outputs("counter").length >= 3}>
          <Task id="inc" output={outputs.counter}>
            {{ n: ctx.outputs("counter").length }}
          </Task>
        </Ralph>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.counter).all();
    expect(rows.length).toBe(3);
    cleanup();
  });

  test("loop with maxIterations caps execution", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ i: z.number() }),
    });

    const workflow = smithers((ctx) => (
      <Workflow name="loop-cap">
        <Ralph id="capped" until={false} maxIterations={3}>
          <Task id="step" output={outputs.out}>
            {{ i: ctx.iteration }}
          </Task>
        </Ralph>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.out).all();
    expect(rows.length).toBe(3);
    cleanup();
  });

  test("continueOnFail allows subsequent tasks to run", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      a: z.object({ v: z.number() }),
      b: z.object({ v: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="continue">
        <Sequence>
          <Task id="fail" output={outputs.a} continueOnFail>
            {() => { throw new Error("deliberate"); }}
          </Task>
          <Task id="after" output={outputs.b}>
            {{ v: 99 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.b).all();
    expect(rows[0].v).toBe(99);
    cleanup();
  });

  test("retries exhaustion fails the workflow", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="retry-exhaust">
        <Task id="flaky" output={outputs.out} retries={1}>
          {() => { throw new Error("always fails"); }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("failed");
    cleanup();
  });

  test("skipIf prevents task execution", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="skip">
        <Task id="skipped" output={outputs.out} skipIf>
          {{ v: 42 }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.out).all();
    expect(rows.length).toBe(0);
    cleanup();
  });

  test("multiple schemas create independent tables", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      alpha: z.object({ name: z.string() }),
      beta: z.object({ score: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="multi-table">
        <Sequence>
          <Task id="a" output={outputs.alpha}>
            {{ name: "test" }}
          </Task>
          <Task id="b" output={outputs.beta}>
            {{ score: 100 }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const alphaRows = (db as any).select().from(tables.alpha).all();
    const betaRows = (db as any).select().from(tables.beta).all();
    expect(alphaRows[0].name).toBe("test");
    expect(betaRows[0].score).toBe(100);
    cleanup();
  });
});
