import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeWorkflowSession } from "../src/session.ts";
import type { TaskDescriptor, WorkflowGraph, XmlElement } from "../src/graph.ts";

function el(
  tag: string,
  props: Record<string, string> = {},
  children: XmlElement[] = [],
): XmlElement {
  return { kind: "element", tag, props, children };
}

function task(
  nodeId: string,
  overrides: Partial<TaskDescriptor> = {},
): TaskDescriptor {
  return {
    nodeId,
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

function graph(tasks: TaskDescriptor[], xml = el("smithers:workflow")): WorkflowGraph {
  return {
    xml,
    tasks,
    mountedTaskIds: tasks.map((entry) => `${entry.nodeId}::${entry.iteration}`),
  };
}

describe("WorkflowSession", () => {
  test("submits a graph and returns executable tasks", async () => {
    const session = makeWorkflowSession({ runId: "run-1" });
    const decision = await Effect.runPromise(
      session.submitGraph(
        graph(
          [task("a")],
          el("smithers:workflow", {}, [el("smithers:task", { id: "a" })]),
        ),
      ),
    );

    expect(decision._tag).toBe("Execute");
    if (decision._tag === "Execute") {
      expect(decision.tasks.map((entry) => entry.nodeId)).toEqual(["a"]);
    }
    const states = await Effect.runPromise(session.getTaskStates());
    expect(states.get("a::0")).toBe("in-progress");
  });

  test("finishes after task completion", async () => {
    const session = makeWorkflowSession({ runId: "run-2" });
    await Effect.runPromise(
      session.submitGraph(
        graph(
          [task("a")],
          el("smithers:workflow", {}, [el("smithers:task", { id: "a" })]),
        ),
      ),
    );
    const decision = await Effect.runPromise(
      session.taskCompleted({ nodeId: "a", iteration: 0, output: { ok: true } }),
    );

    expect(decision).toEqual({
      _tag: "Finished",
      result: {
        runId: "run-2",
        status: "finished",
        output: { ok: true },
      },
    });
  });

  test("can require a stable re-render before finishing", async () => {
    const session = makeWorkflowSession({
      runId: "run-stable",
      requireStableFinish: true,
    });
    const workflow = graph(
      [task("a")],
      el("smithers:workflow", {}, [el("smithers:task", { id: "a" })]),
    );

    await Effect.runPromise(session.submitGraph(workflow));
    const rerender = await Effect.runPromise(
      session.taskCompleted({ nodeId: "a", iteration: 0, output: { ok: true } }),
    );
    expect(rerender._tag).toBe("ReRender");

    const finished = await Effect.runPromise(session.submitGraph(workflow));
    expect(finished).toEqual({
      _tag: "Finished",
      result: {
        runId: "run-stable",
        status: "finished",
        output: { ok: true },
      },
    });
  });

  test("waits for approval and executes after approval is resolved", async () => {
    const session = makeWorkflowSession({ runId: "run-3" });
    const initial = await Effect.runPromise(
      session.submitGraph(
        graph(
          [task("review", { needsApproval: true })],
          el("smithers:workflow", {}, [el("smithers:task", { id: "review" })]),
        ),
      ),
    );
    expect(initial).toEqual({
      _tag: "Wait",
      reason: { _tag: "Approval", nodeId: "review" },
    });

    const approved = await Effect.runPromise(
      session.approvalResolved("review", { approved: true }),
    );
    expect(approved._tag).toBe("Execute");
    if (approved._tag === "Execute") {
      expect(approved.tasks[0].nodeId).toBe("review");
    }
  });

  test("handles approval timeout with skip semantics", async () => {
    const session = makeWorkflowSession({ runId: "run-approval-timeout" });
    await Effect.runPromise(
      session.submitGraph(
        graph(
          [task("review", { needsApproval: true, approvalOnDeny: "skip" })],
          el("smithers:workflow", {}, [el("smithers:task", { id: "review" })]),
        ),
      ),
    );

    const decision = await Effect.runPromise(session.approvalTimedOut("review"));
    expect(decision._tag).toBe("Finished");
    const states = await Effect.runPromise(session.getTaskStates());
    expect(states.get("review::0")).toBe("skipped");
  });

  test("returns retry backoff after retryable failure", async () => {
    const session = makeWorkflowSession({
      runId: "run-4",
      nowMs: () => 1_000,
    });
    await Effect.runPromise(
      session.submitGraph(
        graph(
          [
            task("a", {
              retries: 1,
              retryPolicy: { backoff: "fixed", initialDelayMs: 500 },
            }),
          ],
          el("smithers:workflow", {}, [el("smithers:task", { id: "a" })]),
        ),
      ),
    );
    const decision = await Effect.runPromise(
      session.taskFailed({ nodeId: "a", iteration: 0, error: new Error("nope") }),
    );

    expect(decision).toEqual({
      _tag: "Wait",
      reason: { _tag: "RetryBackoff", waitMs: 500 },
    });
  });

  test("turns heartbeat timeout into retry backoff when retries remain", async () => {
    const session = makeWorkflowSession({
      runId: "run-heartbeat",
      nowMs: () => 10_000,
    });
    await Effect.runPromise(
      session.submitGraph(
        graph(
          [
            task("a", {
              retries: 1,
              heartbeatTimeoutMs: 1_000,
              retryPolicy: { backoff: "fixed", initialDelayMs: 250 },
            }),
          ],
          el("smithers:workflow", {}, [el("smithers:task", { id: "a" })]),
        ),
      ),
    );

    const decision = await Effect.runPromise(session.heartbeatTimedOut("a", 0));
    expect(decision).toEqual({
      _tag: "Wait",
      reason: { _tag: "RetryBackoff", waitMs: 250 },
    });
  });

  test("fires timers and resumes the scheduling loop", async () => {
    const session = makeWorkflowSession({
      runId: "run-timer",
      nowMs: () => 1_000,
    });
    const initial = await Effect.runPromise(
      session.submitGraph(
        graph(
          [task("sleep", { meta: { __timer: true, __timerDuration: "5s" } })],
          el("smithers:workflow", {}, [el("smithers:timer", { id: "sleep" })]),
        ),
      ),
    );
    expect(initial).toEqual({
      _tag: "Wait",
      reason: { _tag: "Timer", resumeAtMs: 6_000 },
    });

    const fired = await Effect.runPromise(session.timerFired("sleep", 6_000));
    expect(fired).toEqual({
      _tag: "Finished",
      result: {
        runId: "run-timer",
        status: "finished",
        output: { firedAtMs: 6_000 },
      },
    });
  });

  test("matches signals by name and correlation id", async () => {
    const session = makeWorkflowSession({ runId: "run-signal" });
    await Effect.runPromise(
      session.submitGraph(
        graph(
          [
            task("wait", {
              meta: {
                __waitForEvent: true,
                __eventName: "ready",
                __correlationId: "c1",
              },
            }),
          ],
          el("smithers:workflow", {}, [el("smithers:wait-for-event", { id: "wait" })]),
        ),
      ),
    );

    const wrong = await Effect.runPromise(
      session.signalReceived("ready", { ok: false }, "other"),
    );
    expect(wrong._tag).toBe("Wait");

    const matched = await Effect.runPromise(
      session.signalReceived("ready", { ok: true }, "c1"),
    );
    expect(matched).toEqual({
      _tag: "Finished",
      result: {
        runId: "run-signal",
        status: "finished",
        output: { ok: true },
      },
    });
  });

  test("supports cache hits and misses as explicit driver callbacks", async () => {
    const session = makeWorkflowSession({ runId: "run-cache" });
    await Effect.runPromise(
      session.submitGraph(
        graph(
          [task("cached", { cachePolicy: { key: "k" } })],
          el("smithers:workflow", {}, [el("smithers:task", { id: "cached" })]),
        ),
      ),
    );
    const miss = await Effect.runPromise(session.cacheMissed("cached", 0));
    expect(miss._tag).toBe("Wait");

    const hit = await Effect.runPromise(
      session.cacheResolved(
        { nodeId: "cached", iteration: 0, output: { from: "cache" } },
        true,
      ),
    );
    expect(hit).toEqual({
      _tag: "Finished",
      result: {
        runId: "run-cache",
        status: "finished",
        output: { from: "cache" },
      },
    });
  });

  test("recovers orphaned in-progress tasks by making them executable again", async () => {
    const session = makeWorkflowSession({ runId: "run-orphan" });
    await Effect.runPromise(
      session.submitGraph(
        graph(
          [task("a")],
          el("smithers:workflow", {}, [el("smithers:task", { id: "a" })]),
        ),
      ),
    );

    const decision = await Effect.runPromise(session.recoverOrphanedTasks());
    expect(decision._tag).toBe("Execute");
    if (decision._tag === "Execute") {
      expect(decision.tasks.map((entry) => entry.nodeId)).toEqual(["a"]);
    }
  });

  test("cancels while execution is in progress", async () => {
    const session = makeWorkflowSession({ runId: "run-cancel" });
    await Effect.runPromise(
      session.submitGraph(
        graph(
          [task("a")],
          el("smithers:workflow", {}, [el("smithers:task", { id: "a" })]),
        ),
      ),
    );

    const decision = await Effect.runPromise(session.cancelRequested());
    expect(decision).toEqual({
      _tag: "Finished",
      result: {
        runId: "run-cancel",
        status: "cancelled",
        output: undefined,
      },
    });
    const states = await Effect.runPromise(session.getTaskStates());
    expect(states.get("a::0")).toBe("cancelled");
  });

  test("hot reload preserves completed tasks and schedules new mounted work", async () => {
    const session = makeWorkflowSession({ runId: "run-hot" });
    const first = graph(
      [task("a")],
      el("smithers:workflow", {}, [el("smithers:task", { id: "a" })]),
    );
    await Effect.runPromise(session.submitGraph(first));
    await Effect.runPromise(
      session.taskCompleted({ nodeId: "a", iteration: 0, output: "done" }),
    );

    const next = graph(
      [task("a"), task("b", { ordinal: 1 })],
      el("smithers:workflow", {}, [
        el("smithers:task", { id: "a" }),
        el("smithers:task", { id: "b" }),
      ]),
    );
    const decision = await Effect.runPromise(session.hotReloaded(next));
    expect(decision._tag).toBe("Execute");
    if (decision._tag === "Execute") {
      expect(decision.tasks.map((entry) => entry.nodeId)).toEqual(["b"]);
    }
  });

  test("continues as new when a Ralph loop hits its threshold", async () => {
    const session = makeWorkflowSession({ runId: "run-loop" });
    await Effect.runPromise(
      session.submitGraph(
        graph(
          [task("a", { ralphId: "loop" })],
          el("smithers:ralph", { id: "loop", maxIterations: "5", continueAsNewEvery: "1" }, [
            el("smithers:task", { id: "a" }),
          ]),
        ),
      ),
    );

    const decision = await Effect.runPromise(
      session.taskCompleted({ nodeId: "a", iteration: 0, output: "ok" }),
    );
    expect(decision._tag).toBe("ContinueAsNew");
    if (decision._tag === "ContinueAsNew") {
      expect(decision.transition.reason).toBe("loop-threshold");
      expect(decision.transition.iteration).toBe(1);
    }
  });
});
