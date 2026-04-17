/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, Sequence, Parallel, Branch, Loop, MergeQueue, runWorkflow, } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
const schemas = {
    outputA: z.object({ value: z.number() }),
    outputB: z.object({ value: z.number() }),
    outputC: z.object({ value: z.number() }),
};
const END_TO_END_TIMEOUT_MS = 15_000;
function build() {
    return createTestSmithers(schemas);
}
describe("runWorkflow end-to-end", () => {
    test("single static task completes", async () => {
        const { smithers, outputs, cleanup } = build();
        const wf = smithers((_ctx) => (<Workflow name="simple">
          <Task id="t1" output={outputs.outputA}>
            {{ value: 42 }}
          </Task>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("sequence executes tasks in order", async () => {
        const { smithers, outputs, tables, db, cleanup } = build();
        const wf = smithers((_ctx) => (<Workflow name="seq">
          <Sequence>
            <Task id="first" output={outputs.outputA}>
              {{ value: 1 }}
            </Task>
            <Task id="second" output={outputs.outputB}>
              {{ value: 2 }}
            </Task>
          </Sequence>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        const rowsA = await db.select().from(tables.outputA);
        const rowsB = await db.select().from(tables.outputB);
        expect(rowsA.length).toBe(1);
        expect(rowsA[0].value).toBe(1);
        expect(rowsB.length).toBe(1);
        expect(rowsB[0].value).toBe(2);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("parallel tasks all execute", async () => {
        const { smithers, outputs, tables, db, cleanup } = build();
        const wf = smithers((_ctx) => (<Workflow name="par">
          <Parallel>
            <Task id="a" output={outputs.outputA}>
              {{ value: 10 }}
            </Task>
            <Task id="b" output={outputs.outputB}>
              {{ value: 20 }}
            </Task>
          </Parallel>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        const rowsA = await db.select().from(tables.outputA);
        const rowsB = await db.select().from(tables.outputB);
        expect(rowsA[0].value).toBe(10);
        expect(rowsB[0].value).toBe(20);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("branch condition selects correct path", async () => {
        const { smithers, outputs, tables, db, cleanup } = build();
        const wf = smithers((_ctx) => (<Workflow name="branch">
          <Branch if={true} then={<Task id="yes" output={outputs.outputA}>
                {{ value: 1 }}
              </Task>} else={<Task id="no" output={outputs.outputB}>
                {{ value: 0 }}
              </Task>}/>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        const rowsA = await db.select().from(tables.outputA);
        expect(rowsA.length).toBe(1);
        expect(rowsA[0].value).toBe(1);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("compute task executes function", async () => {
        const { smithers, outputs, tables, db, cleanup } = build();
        const wf = smithers((_ctx) => (<Workflow name="compute">
          <Task id="calc" output={outputs.outputA}>
            {() => ({ value: 7 * 6 })}
          </Task>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        const rows = await db.select().from(tables.outputA);
        expect(rows[0].value).toBe(42);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("async compute task works", async () => {
        const { smithers, outputs, tables, db, cleanup } = build();
        const wf = smithers((_ctx) => (<Workflow name="async-compute">
          <Task id="calc" output={outputs.outputA}>
            {async () => {
                await new Promise((r) => setTimeout(r, 10));
                return { value: 99 };
            }}
          </Task>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        const rows = await db.select().from(tables.outputA);
        expect(rows[0].value).toBe(99);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("skipIf task is skipped", async () => {
        const { smithers, outputs, tables, db, cleanup } = build();
        const wf = smithers((_ctx) => (<Workflow name="skip">
          <Task id="skipped" output={outputs.outputA} skipIf>
            {{ value: 1 }}
          </Task>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        const rows = await db.select().from(tables.outputA);
        expect(rows.length).toBe(0);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("continueOnFail allows workflow to complete", async () => {
        const { smithers, outputs, tables, db, cleanup } = build();
        const wf = smithers((_ctx) => (<Workflow name="continue">
          <Sequence>
            <Task id="fail" output={outputs.outputA} continueOnFail noRetry>
              {() => {
                throw new Error("intentional");
            }}
            </Task>
            <Task id="after" output={outputs.outputB}>
              {{ value: 42 }}
            </Task>
          </Sequence>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        const rowsB = await db.select().from(tables.outputB);
        expect(rowsB.length).toBe(1);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("workflow with ctx.outputs access", async () => {
        const { smithers, outputs, tables, db, cleanup } = build();
        const wf = smithers((ctx) => (<Workflow name="ctx-access">
          <Sequence>
            <Task id="first" output={outputs.outputA}>
              {{ value: 10 }}
            </Task>
            <Task id="second" output={outputs.outputB}>
              {() => {
                const firstRow = ctx.latest(outputs.outputA, "first");
                return { value: (firstRow?.value ?? 0) * 2 };
            }}
            </Task>
          </Sequence>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        const rows = await db.select().from(tables.outputB);
        expect(rows[0].value).toBe(20);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("loop iterates until condition", async () => {
        const { smithers, outputs, tables, db, cleanup } = build();
        const wf = smithers((ctx) => (<Workflow name="loop">
          <Loop id="counter" until={ctx.outputs("outputA").length >= 3}>
            <Task id="inc" output={outputs.outputA}>
              {{ value: ctx.outputs("outputA").length }}
            </Task>
          </Loop>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        const rows = await db.select().from(tables.outputA);
        expect(rows.length).toBe(3);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("merge queue limits concurrency", async () => {
        const { smithers, outputs, cleanup } = build();
        const concurrentCount = [];
        let current = 0;
        const wf = smithers((_ctx) => (<Workflow name="mq">
          <MergeQueue maxConcurrency={1}>
            <Task id="a" output={outputs.outputA}>
              {async () => {
                current++;
                concurrentCount.push(current);
                await new Promise((r) => setTimeout(r, 50));
                current--;
                return { value: 1 };
            }}
            </Task>
            <Task id="b" output={outputs.outputB}>
              {async () => {
                current++;
                concurrentCount.push(current);
                await new Promise((r) => setTimeout(r, 50));
                current--;
                return { value: 2 };
            }}
            </Task>
          </MergeQueue>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        // Concurrency should never exceed 1
        expect(Math.max(...concurrentCount)).toBeLessThanOrEqual(1);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("empty workflow finishes", async () => {
        const { smithers, cleanup } = build();
        const wf = smithers((_ctx) => <Workflow name="empty"/>);
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("workflow with input data accessible", async () => {
        const { smithers, outputs, tables, db, cleanup } = build();
        const wf = smithers((ctx) => (<Workflow name="with-input">
          <Task id="use-input" output={outputs.outputA}>
            {() => ({ value: ctx.input?.multiplier ?? 1 })}
          </Task>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, {
            input: { multiplier: 7 },
        }));
        expect(result.status).toBe("finished");
        const rows = await db.select().from(tables.outputA);
        expect(rows[0].value).toBe(7);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("task timeout causes failure", async () => {
        const { smithers, outputs, cleanup } = build();
        const wf = smithers((_ctx) => (<Workflow name="timeout">
          <Task id="slow" output={outputs.outputA} timeoutMs={50} retries={0}>
            {async () => {
                await new Promise((r) => setTimeout(r, 5000));
                return { value: 1 };
            }}
          </Task>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("failed");
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("failing task without continueOnFail causes workflow failure", async () => {
        const { smithers, outputs, cleanup } = build();
        const wf = smithers((_ctx) => (<Workflow name="fail">
          <Task id="broken" output={outputs.outputA} noRetry>
            {() => {
                throw new Error("boom");
            }}
          </Task>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("failed");
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("retries execute the specified number of times", async () => {
        const { smithers, outputs, cleanup } = build();
        let attempts = 0;
        const wf = smithers((_ctx) => (<Workflow name="retry">
          <Task id="flaky" output={outputs.outputA} retries={2}>
            {() => {
                attempts++;
                if (attempts < 3)
                    throw new Error("not yet");
                return { value: attempts };
            }}
          </Task>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
        expect(result.status).toBe("finished");
        expect(attempts).toBe(3);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("onProgress callback receives events", async () => {
        const { smithers, outputs, cleanup } = build();
        const events = [];
        const wf = smithers((_ctx) => (<Workflow name="events">
          <Task id="t1" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, {
            input: {},
            onProgress: (e) => events.push(e.type),
        }));
        expect(result.status).toBe("finished");
        expect(events).toContain("RunStarted");
        expect(events).toContain("NodeStarted");
        expect(events).toContain("NodeFinished");
        expect(events).toContain("RunFinished");
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
    test("abort signal cancels workflow", async () => {
        const { smithers, outputs, cleanup } = build();
        const controller = new AbortController();
        const wf = smithers((_ctx) => (<Workflow name="cancel">
          <Task id="slow" output={outputs.outputA}>
            {async () => {
                await new Promise((r) => setTimeout(r, 5000));
                return { value: 1 };
            }}
          </Task>
        </Workflow>));
        // Abort after a short delay
        setTimeout(() => controller.abort(), 50);
        const result = await Effect.runPromise(runWorkflow(wf, {
            input: {},
            signal: controller.signal,
        }));
        expect(["cancelled", "failed"]).toContain(result.status);
        cleanup();
    }, END_TO_END_TIMEOUT_MS);
});
