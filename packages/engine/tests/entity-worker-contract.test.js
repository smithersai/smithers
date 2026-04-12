/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { z } from "zod";
import { jsx, jsxs } from "smithers/jsx-runtime";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { runWorkflow, } from "smithers";
import { TaskResult, WorkerTask, } from "../src/effect/entity-worker.js";
import { subscribeTaskWorkerDispatches, } from "../src/effect/single-runner.js";
const contractSchemas = {
    activity: z.object({ value: z.number() }),
};
function buildContractSmithers() {
    return createTestSmithers(contractSchemas);
}
describe("entity worker contract", () => {
    test("worker schemas round-trip serializable payloads", () => {
        const decodeWorkerTask = Schema.decodeSync(WorkerTask);
        const decodeTaskResult = Schema.decodeSync(TaskResult);
        expect(decodeWorkerTask({
            executionId: "exec-1",
            bridgeKey: "bridge-1",
            workflowName: "workflow",
            runId: "run-1",
            nodeId: "task-1",
            iteration: 0,
            retries: 2,
            taskKind: "agent",
            dispatchKind: "legacy",
        })).toEqual({
            executionId: "exec-1",
            bridgeKey: "bridge-1",
            workflowName: "workflow",
            runId: "run-1",
            nodeId: "task-1",
            iteration: 0,
            retries: 2,
            taskKind: "agent",
            dispatchKind: "legacy",
        });
        expect(decodeTaskResult({
            _tag: "Success",
            executionId: "exec-1",
            terminal: true,
        })).toEqual({
            _tag: "Success",
            executionId: "exec-1",
            terminal: true,
        });
    });
    test("engine task dispatch flows through the worker entity", async () => {
        const { smithers, Workflow, Task, Sequence, cleanup } = buildContractSmithers();
        const dispatched = [];
        const unsubscribe = subscribeTaskWorkerDispatches((task) => {
            dispatched.push(task);
        });
        const agent = {
            id: "entity-worker-agent",
            tools: {},
            generate: async () => ({ output: { value: 3 } }),
        };
        try {
            const workflow = smithers(() => jsx(Workflow, {
                name: "entity-worker-contract",
                children: jsxs(Sequence, {
                    children: [
                        jsx(Task, {
                            id: "static-task",
                            output: contractSchemas.activity,
                            children: { value: 1 },
                        }),
                        jsx(Task, {
                            id: "compute-task",
                            output: contractSchemas.activity,
                            children: () => ({ value: 2 }),
                        }),
                        jsx(Task, {
                            id: "agent-task",
                            output: contractSchemas.activity,
                            agent,
                            children: "Return an agent result",
                        }),
                    ],
                }),
            }));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            const runDispatches = dispatched.filter((task) => task.runId === result.runId);
            expect(runDispatches).toHaveLength(3);
            const byNodeId = new Map(runDispatches.map((task) => [task.nodeId, task]));
            expect(byNodeId.get("static-task")).toMatchObject({
                taskKind: "static",
                dispatchKind: "static",
            });
            expect(byNodeId.get("compute-task")).toMatchObject({
                taskKind: "compute",
                dispatchKind: "compute",
            });
            expect(byNodeId.get("agent-task")).toMatchObject({
                taskKind: "agent",
                dispatchKind: "legacy",
            });
        }
        finally {
            unsubscribe();
            cleanup();
        }
    }, 30_000);
});
