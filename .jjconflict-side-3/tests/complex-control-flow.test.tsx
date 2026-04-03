/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  Workflow,
  Task,
  Sequence,
  Parallel,
  Branch,
  Ralph,
  renderFrame,
  runWorkflow,
} from "../src/index";
import { createTestSmithers, sleep } from "./helpers";
import { z } from "zod";

describe("nested control flow", () => {
  test("sequence inside parallel executes each sequence independently", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="nested-seq-par">
        <Parallel>
          <Sequence>
            <Task id="a1" output={outputs.out}>
              {async () => { order.push("a1"); await sleep(30); return { v: 1 }; }}
            </Task>
            <Task id="a2" output={outputs.out}>
              {() => { order.push("a2"); return { v: 2 }; }}
            </Task>
          </Sequence>
          <Sequence>
            <Task id="b1" output={outputs.out}>
              {() => { order.push("b1"); return { v: 3 }; }}
            </Task>
            <Task id="b2" output={outputs.out}>
              {() => { order.push("b2"); return { v: 4 }; }}
            </Task>
          </Sequence>
        </Parallel>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {}, maxConcurrency: 4 });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.out).all();
    expect(rows.length).toBe(4);
    expect(order.indexOf("a1")).toBeLessThan(order.indexOf("a2"));
    expect(order.indexOf("b1")).toBeLessThan(order.indexOf("b2"));
    cleanup();
  });

  test("parallel inside sequence waits for all parallel tasks", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    const order: string[] = [];
    const workflow = smithers(() => (
      <Workflow name="par-in-seq">
        <Sequence>
          <Parallel>
            <Task id="p1" output={outputs.out}>
              {async () => { await sleep(20); order.push("p1"); return { v: 1 }; }}
            </Task>
            <Task id="p2" output={outputs.out}>
              {() => { order.push("p2"); return { v: 2 }; }}
            </Task>
          </Parallel>
          <Task id="after" output={outputs.out}>
            {() => { order.push("after"); return { v: 3 }; }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {}, maxConcurrency: 4 });
    expect(r.status).toBe("finished");
    expect(order.indexOf("after")).toBeGreaterThan(order.indexOf("p1"));
    expect(order.indexOf("after")).toBeGreaterThan(order.indexOf("p2"));
    cleanup();
  });

  test("branch inside loop selects path each iteration", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      even: z.object({ v: z.number() }),
      odd: z.object({ v: z.number() }),
    });

    const workflow = smithers((ctx) => (
      <Workflow name="branch-in-loop">
        <Ralph id="loop" until={ctx.iteration >= 4} maxIterations={5}>
          <Branch
            if={ctx.iteration % 2 === 0}
            then={
              <Task id="even" output={outputs.even}>
                {{ v: ctx.iteration }}
              </Task>
            }
            else={
              <Task id="odd" output={outputs.odd}>
                {{ v: ctx.iteration }}
              </Task>
            }
          />
        </Ralph>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const evenRows = (db as any).select().from(tables.even).all();
    const oddRows = (db as any).select().from(tables.odd).all();
    expect(evenRows.length).toBeGreaterThanOrEqual(2);
    expect(oddRows.length).toBeGreaterThanOrEqual(2);
    cleanup();
  });

  test("loop inside sequence gates subsequent tasks", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      loop: z.object({ i: z.number() }),
      after: z.object({ count: z.number() }),
    });

    const workflow = smithers((ctx) => (
      <Workflow name="loop-then-task">
        <Sequence>
          <Ralph id="loop" until={ctx.outputs("loop").length >= 3} maxIterations={5}>
            <Task id="step" output={outputs.loop}>
              {{ i: ctx.iteration }}
            </Task>
          </Ralph>
          <Task id="summary" output={outputs.after}>
            {{ count: ctx.outputs("loop").length }}
          </Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const afterRows = (db as any).select().from(tables.after).all();
    expect(afterRows[0].count).toBe(3);
    cleanup();
  });

  test("parallel tasks with skipIf conditionally exclude", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="par-skip">
        <Parallel>
          <Task id="a" output={outputs.out}>{{ v: 1 }}</Task>
          <Task id="b" output={outputs.out} skipIf>{{ v: 2 }}</Task>
          <Task id="c" output={outputs.out}>{{ v: 3 }}</Task>
        </Parallel>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.out).all();
    const nodeIds = rows.map((r: any) => r.nodeId).sort();
    expect(nodeIds).toContain("a");
    expect(nodeIds).toContain("c");
    expect(nodeIds).not.toContain("b");
    cleanup();
  });

  test("sequence with all tasks skipped finishes successfully", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="all-skip">
        <Sequence>
          <Task id="a" output={outputs.out} skipIf>{{ v: 1 }}</Task>
          <Task id="b" output={outputs.out} skipIf>{{ v: 2 }}</Task>
        </Sequence>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    cleanup();
  });

  test("empty workflow finishes immediately", async () => {
    const { smithers, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="empty" />
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    cleanup();
  });
});

describe("renderFrame", () => {
  test("renders without executing tasks", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    let executed = false;
    const workflow = smithers(() => (
      <Workflow name="frame-pure">
        <Task id="t" output={outputs.out}>
          {() => { executed = true; return { v: 1 }; }}
        </Task>
      </Workflow>
    ));

    const frame = await renderFrame(workflow, {
      runId: "test",
      iteration: 0,
      input: {},
      outputs: {},
    });

    expect(executed).toBe(false);
    expect(frame.tasks.length).toBe(1);
    expect(frame.tasks[0].nodeId).toBe("t");
    cleanup();
  });

  test("renderFrame assigns ordinals in tree order", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="ordinals">
        <Sequence>
          <Task id="first" output={outputs.out}>{{ v: 1 }}</Task>
          <Task id="second" output={outputs.out}>{{ v: 2 }}</Task>
          <Task id="third" output={outputs.out}>{{ v: 3 }}</Task>
        </Sequence>
      </Workflow>
    ));

    const frame = await renderFrame(workflow, {
      runId: "test",
      iteration: 0,
      input: {},
      outputs: {},
    });

    const ordinals = frame.tasks.map((t) => t.ordinal);
    expect(ordinals[0]).toBeLessThan(ordinals[1]);
    expect(ordinals[1]).toBeLessThan(ordinals[2]);
    cleanup();
  });
});
