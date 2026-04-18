/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { MergeQueue, Parallel, Task, Workflow, runWorkflow, } from "smithers-orchestrator";
import { createTestSmithers, sleep } from "./helpers.js";
import { outputSchemas } from "./schema.js";
import { Effect } from "effect";
function buildSmithers() {
    return createTestSmithers(outputSchemas);
}
describe("<MergeQueue>", () => {
    test("explicit id propagates to child task descriptors", async () => {
        const renderer = new SmithersRenderer();
        const res = await renderer.render(<Workflow name="mq-id">
        <MergeQueue id="my-queue">
          <Task id="a" output={outputSchemas.outputC}>
            {{ value: 1 }}
          </Task>
          <Task id="b" output={outputSchemas.outputC}>
            {{ value: 2 }}
          </Task>
        </MergeQueue>
      </Workflow>);
        expect(res.tasks.length).toBe(2);
        expect(res.tasks[0].parallelGroupId).toBe("my-queue");
        expect(res.tasks[1].parallelGroupId).toBe("my-queue");
    }, 30_000);
    test("extract sets parallel group with default concurrency 1", async () => {
        const renderer = new SmithersRenderer();
        const res = await renderer.render(<Workflow name="mq">
        <MergeQueue>
          <Task id="m1" output={outputSchemas.outputC}>
            {{ value: 1 }}
          </Task>
          <Task id="m2" output={outputSchemas.outputC}>
            {{ value: 2 }}
          </Task>
        </MergeQueue>
      </Workflow>);
        expect(res.tasks.length).toBe(2);
        const g1 = res.tasks[0].parallelGroupId;
        const g2 = res.tasks[1].parallelGroupId;
        expect(typeof g1).toBe("string");
        expect(g1 && g1.length > 0).toBe(true);
        expect(g1).toBe(g2);
        expect(res.tasks[0].parallelMaxConcurrency).toBe(1);
        expect(res.tasks[1].parallelMaxConcurrency).toBe(1);
    }, 30_000);
    test("skipIf prevents subtree extraction", async () => {
        const renderer = new SmithersRenderer();
        const res = await renderer.render(<Workflow name="mq">
        <MergeQueue skipIf>
          <Task id="m1" output={outputSchemas.outputC}>
            {{ value: 1 }}
          </Task>
        </MergeQueue>
      </Workflow>);
        expect(res.tasks.length).toBe(0);
    }, 30_000);
    test("engine enforces default concurrency = 1 within queue", async () => {
        const { smithers, cleanup, outputs } = buildSmithers();
        let current = 0;
        let max = 0;
        const agent = {
            id: "fake",
            generate: async ({ prompt }) => {
                current += 1;
                if (current > max)
                    max = current;
                await sleep(30);
                current -= 1;
                return { output: { value: 1 } };
            },
        };
        const wf = smithers((_ctx) => (<Workflow name="mq-run">
        <MergeQueue>
          {Array.from({ length: 4 }, (_, i) => (<Task key={`m${i}`} id={`m${i}`} output={outputs.outputC} agent={agent}>
              {`v:${i}`}
            </Task>))}
        </MergeQueue>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {}, maxConcurrency: 4 }));
        expect(result.status).toBe("finished");
        expect(max).toBeLessThanOrEqual(1);
        cleanup();
    }, 30_000);
    test("engine respects provided maxConcurrency on queue", async () => {
        const { smithers, cleanup, outputs } = buildSmithers();
        let current = 0;
        let max = 0;
        const agent = {
            id: "fake",
            generate: async ({ prompt }) => {
                current += 1;
                if (current > max)
                    max = current;
                await sleep(20);
                current -= 1;
                return { output: { value: 1 } };
            },
        };
        const wf = smithers((_ctx) => (<Workflow name="mq-2">
        <MergeQueue maxConcurrency={2}>
          {Array.from({ length: 5 }, (_, i) => (<Task key={`m${i}`} id={`mm${i}`} output={outputs.outputC} agent={agent}>
              {`v:${i}`}
            </Task>))}
        </MergeQueue>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {}, maxConcurrency: 4 }));
        expect(result.status).toBe("finished");
        expect(max).toBeLessThanOrEqual(2);
        cleanup();
    }, 30_000);
    test("innermost group controls concurrency when nested inside Parallel", async () => {
        const { smithers, cleanup, outputs } = buildSmithers();
        let queueCurrent = 0, queueMax = 0;
        let outsideCurrent = 0, outsideMax = 0;
        const agent = {
            id: "fake",
            generate: async ({ prompt }) => {
                const isQueue = String(prompt ?? "").startsWith("q:");
                if (isQueue) {
                    queueCurrent += 1;
                    queueMax = Math.max(queueMax, queueCurrent);
                    await sleep(25);
                    queueCurrent -= 1;
                }
                else {
                    outsideCurrent += 1;
                    outsideMax = Math.max(outsideMax, outsideCurrent);
                    await sleep(25);
                    outsideCurrent -= 1;
                }
                return { output: { value: 1 } };
            },
        };
        const wf = smithers((_ctx) => (<Workflow name="mq-nest">
        <Parallel maxConcurrency={3}>
          <MergeQueue>
            {Array.from({ length: 3 }, (_, i) => (<Task key={`q${i}`} id={`q${i}`} output={outputs.outputC} agent={agent}>
                {`q:${i}`}
              </Task>))}
          </MergeQueue>
          <Task id="o0" output={outputs.outputC} agent={agent}>
            o:0
          </Task>
          <Task id="o1" output={outputs.outputC} agent={agent}>
            o:1
          </Task>
        </Parallel>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(wf, { input: {}, maxConcurrency: 4 }));
        expect(result.status).toBe("finished");
        expect(queueMax).toBeLessThanOrEqual(1);
        expect(outsideMax).toBeGreaterThanOrEqual(1);
        cleanup();
    }, 30_000);
    test("edge maxConcurrency values clamp to 1 at extract time", async () => {
        const renderer = new SmithersRenderer();
        const baseChildren = (<>
        <Task id="e1" output={outputSchemas.outputC}>
          {{ value: 1 }}
        </Task>
        <Task id="e2" output={outputSchemas.outputC}>
          {{ value: 2 }}
        </Task>
      </>);
        // 0 -> 1
        let res = await renderer.render(<Workflow name="mq-edge-0">
        <MergeQueue maxConcurrency={0}>{baseChildren}</MergeQueue>
      </Workflow>);
        expect(res.tasks[0].parallelMaxConcurrency).toBe(1);
        expect(res.tasks[1].parallelMaxConcurrency).toBe(1);
        // -1 -> 1
        res = await renderer.render(<Workflow name="mq-edge-neg">
        <MergeQueue maxConcurrency={-1}>{baseChildren}</MergeQueue>
      </Workflow>);
        expect(res.tasks[0].parallelMaxConcurrency).toBe(1);
        expect(res.tasks[1].parallelMaxConcurrency).toBe(1);
        // 1.7 -> floor(1.7) = 1
        res = await renderer.render(<Workflow name="mq-edge-fraction">
        <MergeQueue maxConcurrency={1.7}>{baseChildren}</MergeQueue>
      </Workflow>);
        expect(res.tasks[0].parallelMaxConcurrency).toBe(1);
        expect(res.tasks[1].parallelMaxConcurrency).toBe(1);
    }, 30_000);
    /**
   * @param {number} mc
   */
    async function expectMergeQueueRuntimeClamp(mc) {
        const { smithers, cleanup, outputs } = buildSmithers();
        let concurrent = 0;
        let peak = 0;
        const agent = {
            id: "fake",
            generate: async () => {
                concurrent += 1;
                peak = Math.max(peak, concurrent);
                await sleep(20);
                concurrent -= 1;
                return { output: { value: 1 } };
            },
        };
        /**
     * @param {any} mc
     */
        const runCase = async (mc) => {
            peak = 0;
            const wf = smithers((_ctx) => (<Workflow name={`mq-edge-run-${String(mc)}`}>
          <MergeQueue maxConcurrency={mc}>
            {Array.from({ length: 3 }, (_, i) => (<Task key={`t${i}`} id={`t${mc}-${i}`} output={outputs.outputC} agent={agent}>
                run task
              </Task>))}
          </MergeQueue>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(wf, { input: {}, maxConcurrency: 3 }));
            expect(result.status).toBe("finished");
            expect(peak).toBeLessThanOrEqual(1);
        };
        try {
            await runCase(mc);
        }
        finally {
            cleanup();
        }
    }
    test("engine clamps maxConcurrency={0} to 1 for MergeQueue", async () => {
        await expectMergeQueueRuntimeClamp(0);
    }, 30_000);
    test("engine clamps maxConcurrency={-1} to 1 for MergeQueue", async () => {
        await expectMergeQueueRuntimeClamp(-1);
    }, 30_000);
    test("engine clamps fractional maxConcurrency to 1 for MergeQueue", async () => {
        await expectMergeQueueRuntimeClamp(1.7);
    }, 30_000);
});
