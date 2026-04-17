/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, Sequence, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
const schemas = { out: z.object({ v: z.number() }) };
describe("onProgress events", () => {
    test("emits RunStarted and RunFinished for successful workflow", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        const events = [];
        const workflow = smithers(() => (<Workflow name="events">
        <Task id="t" output={outputs.out}>{{ v: 1 }}</Task>
      </Workflow>));
        await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            onProgress: (e) => events.push(e),
        }));
        const types = events.map((e) => e.type);
        expect(types).toContain("RunStarted");
        expect(types).toContain("RunFinished");
        cleanup();
    });
    test("emits NodeStarted and NodeFinished for each task", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        const events = [];
        const workflow = smithers(() => (<Workflow name="node-events">
        <Task id="t" output={outputs.out}>{{ v: 1 }}</Task>
      </Workflow>));
        await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            onProgress: (e) => events.push(e),
        }));
        const nodeStarted = events.filter((e) => e.type === "NodeStarted");
        const nodeFinished = events.filter((e) => e.type === "NodeFinished");
        expect(nodeStarted.length).toBeGreaterThanOrEqual(1);
        expect(nodeFinished.length).toBeGreaterThanOrEqual(1);
        cleanup();
    });
    test("emits NodeFailed for failing task", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        const events = [];
        const workflow = smithers(() => (<Workflow name="fail-events">
        <Task id="fail" output={outputs.out} noRetry>
          {() => { throw new Error("boom"); }}
        </Task>
      </Workflow>));
        await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            onProgress: (e) => events.push(e),
        }));
        const types = events.map((e) => e.type);
        expect(types).toContain("NodeFailed");
        expect(types).toContain("RunFailed");
        cleanup();
    });
    test("emits NodeSkipped for skipIf tasks", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        const events = [];
        const workflow = smithers(() => (<Workflow name="skip-events">
        <Task id="skipped" output={outputs.out} skipIf>
          {{ v: 1 }}
        </Task>
      </Workflow>));
        await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            onProgress: (e) => events.push(e),
        }));
        const types = events.map((e) => e.type);
        expect(types).toContain("NodeSkipped");
        cleanup();
    });
    test("RunStarted comes before NodeStarted", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        const events = [];
        const workflow = smithers(() => (<Workflow name="order">
        <Task id="t" output={outputs.out}>{{ v: 1 }}</Task>
      </Workflow>));
        await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            onProgress: (e) => events.push(e),
        }));
        const types = events.map((e) => e.type);
        const runStartIdx = types.indexOf("RunStarted");
        const nodeStartIdx = types.indexOf("NodeStarted");
        expect(runStartIdx).toBeLessThan(nodeStartIdx);
        cleanup();
    });
    test("NodeFinished comes before RunFinished", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        const events = [];
        const workflow = smithers(() => (<Workflow name="end-order">
        <Task id="t" output={outputs.out}>{{ v: 1 }}</Task>
      </Workflow>));
        await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            onProgress: (e) => events.push(e),
        }));
        const types = events.map((e) => e.type);
        const lastNodeFinished = types.lastIndexOf("NodeFinished");
        const runFinished = types.indexOf("RunFinished");
        expect(lastNodeFinished).toBeLessThan(runFinished);
        cleanup();
    });
    test("events include runId", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        const events = [];
        const myRunId = "custom-run-id";
        const workflow = smithers(() => (<Workflow name="run-id-event">
        <Task id="t" output={outputs.out}>{{ v: 1 }}</Task>
      </Workflow>));
        await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId: myRunId,
            onProgress: (e) => events.push(e),
        }));
        for (const e of events) {
            expect(e.runId).toBe(myRunId);
        }
        cleanup();
    });
});
describe("abort signal", () => {
    test("AbortSignal cancels running workflow", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        const controller = new AbortController();
        const workflow = smithers(() => (<Workflow name="abort">
        <Task id="slow" output={outputs.out}>
          {async () => {
                await sleep(2000);
                return { v: 1 };
            }}
        </Task>
      </Workflow>));
        setTimeout(() => controller.abort(), 50);
        const r = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            signal: controller.signal,
        }));
        expect(r.status).toBe("cancelled");
        cleanup();
    });
    test("pre-aborted signal cancels immediately", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        const controller = new AbortController();
        controller.abort();
        const workflow = smithers(() => (<Workflow name="pre-abort">
        <Task id="never" output={outputs.out}>
          {{ v: 1 }}
        </Task>
      </Workflow>));
        const r = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            signal: controller.signal,
        }));
        expect(r.status).toBe("cancelled");
        cleanup();
    });
});
