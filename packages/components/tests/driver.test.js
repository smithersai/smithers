import { describe, expect, it } from "bun:test";
import React from "react";
import { ReactWorkflowDriver } from "@smithers/react-reconciler/driver";
/**
 * @param {Partial<TaskDescriptor>} overrides
 * @returns {TaskDescriptor}
 */
function taskDescriptor(overrides) {
    return {
        nodeId: "task-a",
        ordinal: 0,
        iteration: 0,
        outputTable: null,
        outputTableName: "",
        needsApproval: false,
        skipIf: false,
        retries: 0,
        timeoutMs: null,
        heartbeatTimeoutMs: null,
        continueOnFail: false,
        ...overrides,
    };
}
describe("ReactWorkflowDriver", () => {
    it("drives render, submit, execute, re-render, and finish through the session API", async () => {
        const runPromiseInputs = [];
        const runtime = {
            /**
       * @template A
       * @param {unknown} effect
       * @returns {Promise<A>}
       */
            async runPromise(effect) {
                runPromiseInputs.push(effect);
                return (await effect);
            },
        };
        const graph = {
            xml: null,
            tasks: [],
            mountedTaskIds: [],
        };
        const renderedIterations = [];
        const completed = [];
        let submitCount = 0;
        const workflow = {
            opts: {},
            build(ctx) {
                renderedIterations.push(ctx.iteration);
                if (ctx.iteration === 1) {
                    expect(ctx.outputMaybe("out", { nodeId: "task-a", iteration: 0 })).toEqual({
                        nodeId: "task-a",
                        iteration: 0,
                        value: "done",
                    });
                }
                return React.createElement("smithers:workflow", { name: "driver" });
            },
        };
        const rerender = {
            _tag: "ReRender",
            context: {
                runId: "run-1",
                iteration: 1,
                ralphIterations: new Map(),
                graph: {
                    xml: null,
                    tasks: [
                        taskDescriptor({
                            nodeId: "task-a",
                            iteration: 0,
                            outputTableName: "out",
                        }),
                    ],
                    mountedTaskIds: ["task-a::0"],
                },
                outputs: new Map([
                    [
                        "task-a::0",
                        {
                            nodeId: "task-a",
                            iteration: 0,
                            output: { value: "done" },
                        },
                    ],
                ]),
            },
        };
        const session = {
            /**
       * @param {WorkflowGraph} submitted
       */
            submitGraph(submitted) {
                expect(submitted).toBe(graph);
                submitCount += 1;
                if (submitCount === 1) {
                    return {
                        _tag: "Execute",
                        tasks: [
                            taskDescriptor({
                                nodeId: "task-a",
                                iteration: 0,
                                staticPayload: "done",
                            }),
                        ],
                    };
                }
                return {
                    _tag: "Finished",
                    result: { runId: "run-1", status: "finished", output: "ok" },
                };
            },
            /**
       * @param {unknown} event
       */
            taskCompleted(event) {
                completed.push(event);
                return undefined;
            },
            /**
       * @param {unknown} error
       */
            taskFailed(error) {
                throw error;
            },
            getNextDecision() {
                return rerender;
            },
        };
        const driver = new ReactWorkflowDriver({
            workflow,
            runtime,
            session,
            renderer: {
                render() {
                    return graph;
                },
            },
        });
        const result = await driver.run({
            runId: "run-1",
            input: { hello: "world" },
        });
        expect(result).toEqual({
            runId: "run-1",
            status: "finished",
            output: "ok",
        });
        expect(renderedIterations).toEqual([0, 1]);
        expect(completed).toEqual([
            {
                nodeId: "task-a",
                iteration: 0,
                output: "done",
            },
        ]);
        expect(runPromiseInputs).toHaveLength(4);
    });
    it("maps every default wait reason to a result or follow-up decision", async () => {
        const runtime = {
            /**
       * @template A
       * @param {unknown} effect
       * @returns {Promise<A>}
       */
            async runPromise(effect) {
                return (await effect);
            },
        };
        const workflow = {
            opts: {},
            build: () => React.createElement("smithers:workflow", { name: "waits" }),
        };
        const graph = { xml: null, tasks: [], mountedTaskIds: [] };
        /**
     * @param {EngineDecision} decision
     * @param {Partial<WorkflowSession>} [sessionPatch]
     */
        async function runWith(decision, sessionPatch = {}) {
            const session = {
                submitGraph: () => decision,
                taskCompleted: () => ({ _tag: "Finished", result: { runId: "run-wait", status: "finished" } }),
                taskFailed: () => ({ _tag: "Failed", error: new Error("failed") }),
                ...sessionPatch,
            };
            const driver = new ReactWorkflowDriver({
                workflow,
                runtime,
                session,
                renderer: { render: () => graph },
            });
            return driver.run({ runId: "run-wait", input: {} });
        }
        await expect(runWith({ _tag: "Wait", reason: { _tag: "Approval", nodeId: "gate" } })).resolves.toMatchObject({ status: "waiting-approval" });
        await expect(runWith({ _tag: "Wait", reason: { _tag: "Event", eventName: "signal" } })).resolves.toMatchObject({ status: "waiting-event" });
        await expect(runWith({ _tag: "Wait", reason: { _tag: "Timer", resumeAtMs: Date.now() + 1000 } })).resolves.toMatchObject({ status: "waiting-timer" });
        await expect(runWith({ _tag: "Wait", reason: { _tag: "ExternalTrigger" } })).resolves.toMatchObject({ status: "waiting-event" });
        await expect(runWith({ _tag: "Wait", reason: { _tag: "RetryBackoff", waitMs: 1 } }, {
            getNextDecision: () => ({
                _tag: "Finished",
                result: { runId: "run-wait", status: "finished", output: "retried" },
            }),
        })).resolves.toMatchObject({ status: "finished", output: "retried" });
    });
    it("returns failed results for Failed decisions", async () => {
        const runtime = {
            /**
       * @template A
       * @param {unknown} effect
       * @returns {Promise<A>}
       */
            async runPromise(effect) {
                return (await effect);
            },
        };
        const error = new Error("boom");
        const session = {
            submitGraph: () => ({ _tag: "Failed", error }),
            taskCompleted: () => undefined,
            taskFailed: () => undefined,
        };
        const driver = new ReactWorkflowDriver({
            workflow: {
                opts: {},
                build: () => React.createElement("smithers:workflow", { name: "failed" }),
            },
            runtime,
            session,
            renderer: {
                render: () => ({ xml: null, tasks: [], mountedTaskIds: [] }),
            },
        });
        await expect(driver.run({ runId: "run-failed", input: {} })).resolves.toEqual({
            runId: "run-failed",
            status: "failed",
            error,
        });
    });
    it("cancels through the session when the abort signal is already aborted", async () => {
        const runtime = {
            /**
       * @template A
       * @param {unknown} effect
       * @returns {Promise<A>}
       */
            async runPromise(effect) {
                return (await effect);
            },
        };
        let cancelled = false;
        const session = {
            submitGraph: () => {
                throw new Error("should not submit after abort");
            },
            taskCompleted: () => undefined,
            taskFailed: () => undefined,
            cancelRequested: () => {
                cancelled = true;
                return {
                    _tag: "Finished",
                    result: { runId: "run-cancel", status: "cancelled" },
                };
            },
        };
        const controller = new AbortController();
        controller.abort();
        const driver = new ReactWorkflowDriver({
            workflow: {
                opts: {},
                build: () => React.createElement("smithers:workflow", { name: "cancelled" }),
            },
            runtime,
            session,
            renderer: {
                render: () => ({ xml: null, tasks: [], mountedTaskIds: [] }),
            },
        });
        await expect(driver.run({ runId: "run-cancel", input: {}, signal: controller.signal })).resolves.toEqual({ runId: "run-cancel", status: "cancelled" });
        expect(cancelled).toBe(true);
    });
});
