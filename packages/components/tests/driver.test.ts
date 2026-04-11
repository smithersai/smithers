import { describe, expect, it } from "bun:test";
import React from "react";
import { ReactWorkflowDriver } from "@smithers/react-reconciler/driver";
import type {
  EngineDecision,
  SmithersWorkflow,
  TaskDescriptor,
  WorkflowGraph,
  WorkflowRuntime,
  WorkflowSession,
} from "../src/types";

function taskDescriptor(overrides: Partial<TaskDescriptor>): TaskDescriptor {
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
    const runPromiseInputs: unknown[] = [];
    const runtime: WorkflowRuntime = {
      async runPromise<A>(effect: unknown): Promise<A> {
        runPromiseInputs.push(effect);
        return (await effect) as A;
      },
    };

    const graph: WorkflowGraph = {
      xml: null,
      tasks: [],
      mountedTaskIds: [],
    };
    const renderedIterations: number[] = [];
    const completed: unknown[] = [];
    let submitCount = 0;

    const workflow: SmithersWorkflow = {
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

    const rerender: EngineDecision = {
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
      submitGraph(submitted: WorkflowGraph) {
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
          } satisfies EngineDecision;
        }
        return {
          _tag: "Finished",
          result: { runId: "run-1", status: "finished", output: "ok" },
        } satisfies EngineDecision;
      },
      taskCompleted(event: unknown) {
        completed.push(event);
        return undefined;
      },
      taskFailed(error: unknown) {
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
    const runtime: WorkflowRuntime = {
      async runPromise<A>(effect: unknown): Promise<A> {
        return (await effect) as A;
      },
    };
    const workflow: SmithersWorkflow = {
      opts: {},
      build: () => React.createElement("smithers:workflow", { name: "waits" }),
    };
    const graph: WorkflowGraph = { xml: null, tasks: [], mountedTaskIds: [] };

    async function runWith(decision: EngineDecision, sessionPatch: Partial<WorkflowSession> = {}) {
      const session: WorkflowSession = {
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

    await expect(
      runWith({ _tag: "Wait", reason: { _tag: "Approval", nodeId: "gate" } }),
    ).resolves.toMatchObject({ status: "waiting-approval" });
    await expect(
      runWith({ _tag: "Wait", reason: { _tag: "Event", eventName: "signal" } }),
    ).resolves.toMatchObject({ status: "waiting-event" });
    await expect(
      runWith({ _tag: "Wait", reason: { _tag: "Timer", resumeAtMs: Date.now() + 1000 } }),
    ).resolves.toMatchObject({ status: "waiting-timer" });
    await expect(
      runWith({ _tag: "Wait", reason: { _tag: "ExternalTrigger" } }),
    ).resolves.toMatchObject({ status: "waiting-event" });
    await expect(
      runWith(
        { _tag: "Wait", reason: { _tag: "RetryBackoff", waitMs: 1 } },
        {
          getNextDecision: () => ({
            _tag: "Finished",
            result: { runId: "run-wait", status: "finished", output: "retried" },
          }),
        },
      ),
    ).resolves.toMatchObject({ status: "finished", output: "retried" });
  });

  it("returns failed results for Failed decisions", async () => {
    const runtime: WorkflowRuntime = {
      async runPromise<A>(effect: unknown): Promise<A> {
        return (await effect) as A;
      },
    };
    const error = new Error("boom");
    const session: WorkflowSession = {
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
    const runtime: WorkflowRuntime = {
      async runPromise<A>(effect: unknown): Promise<A> {
        return (await effect) as A;
      },
    };
    let cancelled = false;
    const session: WorkflowSession = {
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
        } satisfies EngineDecision;
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

    await expect(
      driver.run({ runId: "run-cancel", input: {}, signal: controller.signal }),
    ).resolves.toEqual({ runId: "run-cancel", status: "cancelled" });
    expect(cancelled).toBe(true);
  });
});
