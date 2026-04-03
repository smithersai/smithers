/** @jsxImportSource smithers */
/**
 * Regression test: Loop `until` must re-evaluate from fresh DB data
 * after each iteration completes.
 *
 * Scenario:
 * - A Loop with `until` that depends on a task output (via ctx.outputMaybe)
 * - The task writes `lgtm: false` on iteration 0
 * - The Loop should re-iterate (advance to iteration 1)
 * - The task writes `lgtm: true` on iteration 1
 * - The Loop should exit
 */
import { describe, expect, test } from "bun:test";
import { Loop, Sequence, Task, Workflow, runWorkflow } from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

describe("Loop until re-evaluation", () => {
  test("Loop exits when until becomes true after iteration", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      review: z.object({ lgtm: z.boolean() }),
    });

    let callCount = 0;
    const agent = {
      id: "review-agent",
      tools: {},
      generate: async () => {
        callCount += 1;
        // First call (iteration 0) -> lgtm: false
        // Second call (iteration 1) -> lgtm: true
        return { output: { lgtm: callCount >= 2 } };
      },
    };

    const workflow = smithers((ctx) => {
      const latestReview = ctx.latest("review", "review-task");
      return (
        <Workflow name="loop-until-reeval">
          <Loop
            id="review-loop"
            until={latestReview?.lgtm === true}
            maxIterations={5}
          >
            <Task id="review-task" output={outputs.review} agent={agent}>
              Review this code
            </Task>
          </Loop>
        </Workflow>
      );
    });

    const result = await runWorkflow(workflow, {
      input: {},
      runId: "loop-until-reeval",
    });

    expect(result.status).toBe("finished");
    // Agent should be called exactly twice: once for iteration 0, once for iteration 1
    expect(callCount).toBe(2);

    // Verify DB has both iterations
    const rows = await (db as any).select().from(tables.review);
    const sorted = rows
      .map((r: any) => ({ iteration: r.iteration, lgtm: r.lgtm }))
      .sort((a: any, b: any) => a.iteration - b.iteration);
    expect(sorted).toEqual([
      { iteration: 0, lgtm: false },
      { iteration: 1, lgtm: true },
    ]);

    cleanup();
  });

  test("Loop exits when until becomes true (outputMaybe with explicit iteration)", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      review: z.object({ lgtm: z.boolean() }),
    });

    let callCount = 0;
    const agent = {
      id: "review-agent-2",
      tools: {},
      generate: async () => {
        callCount += 1;
        return { output: { lgtm: callCount >= 2 } };
      },
    };

    const workflow = smithers((ctx) => {
      // Use outputMaybe with explicit iteration from the loop
      const currentIteration = ctx.iterations?.["review-loop"] ?? ctx.iteration;
      const review = ctx.outputMaybe("review", {
        nodeId: "review-task",
        iteration: currentIteration,
      });
      return (
        <Workflow name="loop-until-reeval-2">
          <Loop
            id="review-loop"
            until={review?.lgtm === true}
            maxIterations={5}
          >
            <Task id="review-task" output={outputs.review} agent={agent}>
              Review this code
            </Task>
          </Loop>
        </Workflow>
      );
    });

    const result = await runWorkflow(workflow, {
      input: {},
      runId: "loop-until-reeval-2",
    });

    expect(result.status).toBe("finished");
    expect(callCount).toBe(2);

    cleanup();
  });

  test("parallel loops each re-evaluate until independently (ctx.latest)", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      review: z.object({ lgtm: z.boolean() }),
    });

    const callCounts: Record<string, number> = {};
    const makeAgent = (taskId: string) => ({
      id: `agent-${taskId}`,
      tools: {},
      generate: async () => {
        callCounts[taskId] = (callCounts[taskId] ?? 0) + 1;
        // Both return lgtm: true on second call
        return { output: { lgtm: callCounts[taskId] >= 2 } };
      },
    });

    const agent1 = makeAgent("task-1");
    const agent2 = makeAgent("task-2");

    const workflow = smithers((ctx) => {
      const review1 = ctx.latest("review", "task-1");
      const review2 = ctx.latest("review", "task-2");
      return (
        <Workflow name="parallel-loops">
          <Sequence>
            <Loop
              id="loop-1"
              until={review1?.lgtm === true}
              maxIterations={5}
            >
              <Task id="task-1" output={outputs.review} agent={agent1}>
                Review 1
              </Task>
            </Loop>
            <Loop
              id="loop-2"
              until={review2?.lgtm === true}
              maxIterations={5}
            >
              <Task id="task-2" output={outputs.review} agent={agent2}>
                Review 2
              </Task>
            </Loop>
          </Sequence>
        </Workflow>
      );
    });

    const result = await runWorkflow(workflow, {
      input: {},
      runId: "parallel-loops",
    });

    expect(result.status).toBe("finished");
    expect(callCounts["task-1"]).toBe(2);
    expect(callCounts["task-2"]).toBe(2);

    cleanup();
  });

  test("parallel loops with outputMaybe re-evaluate until correctly", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      review: z.object({ lgtm: z.boolean() }),
    });

    const callCounts: Record<string, number> = {};
    const makeAgent = (taskId: string) => ({
      id: `agent-${taskId}`,
      tools: {},
      generate: async () => {
        callCounts[taskId] = (callCounts[taskId] ?? 0) + 1;
        return { output: { lgtm: callCounts[taskId] >= 2 } };
      },
    });

    const agent1 = makeAgent("task-a");
    const agent2 = makeAgent("task-b");

    const workflow = smithers((ctx) => {
      // Use outputMaybe without explicit iteration — this exercises the
      // defaultIteration path. With multiple loops defaultIteration stays
      // at 0 which means outputMaybe only ever returns iteration-0 data.
      const reviewA = ctx.outputMaybe("review", { nodeId: "task-a" });
      const reviewB = ctx.outputMaybe("review", { nodeId: "task-b" });
      return (
        <Workflow name="parallel-loops-outputMaybe">
          <Sequence>
            <Loop
              id="loop-a"
              until={reviewA?.lgtm === true}
              maxIterations={5}
            >
              <Task id="task-a" output={outputs.review} agent={agent1}>
                Review A
              </Task>
            </Loop>
            <Loop
              id="loop-b"
              until={reviewB?.lgtm === true}
              maxIterations={5}
            >
              <Task id="task-b" output={outputs.review} agent={agent2}>
                Review B
              </Task>
            </Loop>
          </Sequence>
        </Workflow>
      );
    });

    const result = await runWorkflow(workflow, {
      input: {},
      runId: "parallel-loops-outputMaybe",
    });

    expect(result.status).toBe("finished");
    expect(callCounts["task-a"]).toBe(2);
    expect(callCounts["task-b"]).toBe(2);

    cleanup();
  });

  test("Loop with outputMaybe re-evaluates until using ctx.iterations", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      review: z.object({ lgtm: z.boolean() }),
    });

    let callCount = 0;
    const agent = {
      id: "review-agent-iter",
      tools: {},
      generate: async () => {
        callCount += 1;
        return { output: { lgtm: callCount >= 2 } };
      },
    };

    const workflow = smithers((ctx) => {
      // Use outputMaybe without explicit iteration — relies on ctx.iteration
      // which is defaultIteration in the engine. With a single loop this
      // should track correctly.
      const review = ctx.outputMaybe("review", { nodeId: "review-task" });
      return (
        <Workflow name="loop-outputMaybe">
          <Loop
            id="review-loop"
            until={review?.lgtm === true}
            maxIterations={5}
          >
            <Task id="review-task" output={outputs.review} agent={agent}>
              Review this code
            </Task>
          </Loop>
        </Workflow>
      );
    });

    const result = await runWorkflow(workflow, {
      input: {},
      runId: "loop-outputMaybe",
    });

    expect(result.status).toBe("finished");
    expect(callCount).toBe(2);

    cleanup();
  });
});
