/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers/db/adapter";
import { retryTask } from "../src/retry-task.js";
import { runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
/**
 * @param {string} nodeId
 * @param {Record<string, number>} callCounts
 * @param {{ failFirst?: boolean }} [behavior]
 */
function makeAgent(nodeId, callCounts, behavior) {
    return {
        id: `agent-${nodeId}`,
        tools: {},
        async generate() {
            callCounts[nodeId] = (callCounts[nodeId] ?? 0) + 1;
            if (behavior?.failFirst && callCounts[nodeId] === 1) {
                throw new Error(`${nodeId} failed on first attempt`);
            }
            return {
                output: {
                    value: callCounts[nodeId],
                },
            };
        },
    };
}
describe("retry-task e2e", () => {
    test("retry-task resets a failed task and resumes to completion", async () => {
        const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            const callCounts = {};
            const workflow = smithers(() => (<Workflow name="retry-single-failed-task">
          <Task id="analyze" output={outputs.outputA} agent={makeAgent("analyze", callCounts)}>
            Analyze the problem.
          </Task>
          <Task id="implement" output={outputs.outputB} agent={makeAgent("implement", callCounts, { failFirst: true })} noRetry deps={{ analyze: outputs.outputA }}>
            {(deps) => `Implement using ${deps.analyze.value}`}
          </Task>
          <Task id="test" output={outputs.outputC} agent={makeAgent("test", callCounts)} deps={{ implement: outputs.outputB }}>
            {(deps) => `Test using ${deps.implement.value}`}
          </Task>
        </Workflow>));
            const runId = "retry-single-failed-task-run";
            const failed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(failed.status).toBe("failed");
            expect(callCounts.analyze).toBe(1);
            expect(callCounts.implement).toBe(1);
            expect(callCounts.test ?? 0).toBe(0);
            const reset = await retryTask(adapter, { runId, nodeId: "implement" });
            expect(reset.success).toBe(true);
            expect(reset.resetNodes).toContain("implement");
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            expect(callCounts.analyze).toBe(1);
            expect(callCounts.implement).toBe(2);
            expect(callCounts.test).toBe(1);
        }
        finally {
            cleanup();
        }
    });
    test("retry-task resets dependents by default", async () => {
        const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            const callCounts = {};
            const workflow = smithers(() => (<Workflow name="retry-reset-dependents">
          <Task id="A" output={outputs.outputA} agent={makeAgent("A", callCounts)}>
            First
          </Task>
          <Task id="B" output={outputs.outputB} agent={makeAgent("B", callCounts)} deps={{ A: outputs.outputA }}>
            {(deps) => `Second ${deps.A.value}`}
          </Task>
          <Task id="C" output={outputs.outputC} agent={makeAgent("C", callCounts)} deps={{ B: outputs.outputB }}>
            {(deps) => `Third ${deps.B.value}`}
          </Task>
        </Workflow>));
            const runId = "retry-reset-dependents-run";
            const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(finished.status).toBe("finished");
            expect(callCounts).toMatchObject({ A: 1, B: 1, C: 1 });
            const reset = await retryTask(adapter, { runId, nodeId: "A" });
            expect(reset.success).toBe(true);
            expect([...reset.resetNodes].sort()).toEqual(["A", "B", "C"]);
            const nodeA = await adapter.getNode(runId, "A", 0);
            const nodeB = await adapter.getNode(runId, "B", 0);
            const nodeC = await adapter.getNode(runId, "C", 0);
            expect(nodeA?.state).toBe("pending");
            expect(nodeB?.state).toBe("pending");
            expect(nodeC?.state).toBe("pending");
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            expect(callCounts).toMatchObject({ A: 2, B: 2, C: 2 });
        }
        finally {
            cleanup();
        }
    });
    test("retry-task with noDeps only resets the target", async () => {
        const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            const callCounts = {};
            const workflow = smithers(() => (<Workflow name="retry-no-deps">
          <Task id="A" output={outputs.outputA} agent={makeAgent("A", callCounts)}>
            First
          </Task>
          <Task id="B" output={outputs.outputB} agent={makeAgent("B", callCounts)} deps={{ A: outputs.outputA }}>
            {(deps) => `Second ${deps.A.value}`}
          </Task>
          <Task id="C" output={outputs.outputC} agent={makeAgent("C", callCounts)} deps={{ B: outputs.outputB }}>
            {(deps) => `Third ${deps.B.value}`}
          </Task>
        </Workflow>));
            const runId = "retry-no-deps-run";
            const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(finished.status).toBe("finished");
            expect(callCounts).toMatchObject({ A: 1, B: 1, C: 1 });
            const reset = await retryTask(adapter, {
                runId,
                nodeId: "B",
                resetDependents: false,
            });
            expect(reset.success).toBe(true);
            expect(reset.resetNodes).toEqual(["B"]);
            const nodeA = await adapter.getNode(runId, "A", 0);
            const nodeB = await adapter.getNode(runId, "B", 0);
            const nodeC = await adapter.getNode(runId, "C", 0);
            expect(nodeA?.state).toBe("finished");
            expect(nodeB?.state).toBe("pending");
            expect(nodeC?.state).toBe("finished");
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            expect(callCounts).toMatchObject({ A: 1, B: 2, C: 1 });
        }
        finally {
            cleanup();
        }
    });
    test("retry-task errors on non-existent node", async () => {
        const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            const workflow = smithers(() => (<Workflow name="retry-missing-node">
          <Task id="existing" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Workflow>));
            const runId = "retry-missing-node-run";
            const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(finished.status).toBe("finished");
            const reset = await retryTask(adapter, {
                runId,
                nodeId: "nonexistent",
            });
            expect(reset.success).toBe(false);
            expect(reset.error).toContain("not found");
        }
        finally {
            cleanup();
        }
    });
    test("retry-task errors on running workflow unless force", async () => {
        const { smithers, Workflow, Task, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            const workflow = smithers(() => (<Workflow name="retry-running-run">
          <Task id="existing" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
        </Workflow>));
            const runId = "retry-running-run-id";
            const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(finished.status).toBe("finished");
            await adapter.updateRun(runId, {
                status: "running",
                finishedAtMs: null,
            });
            const blocked = await retryTask(adapter, {
                runId,
                nodeId: "existing",
            });
            expect(blocked.success).toBe(false);
            expect(blocked.error).toContain("running");
            const forced = await retryTask(adapter, {
                runId,
                nodeId: "existing",
                force: true,
            });
            expect(forced.success).toBe(true);
            expect(forced.resetNodes).toEqual(["existing"]);
        }
        finally {
            cleanup();
        }
    });
});
