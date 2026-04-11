import { describe, expect, test } from "bun:test";
import {
  buildPlanTree,
  buildStateKey,
  scheduleTasks,
  type PlanNode,
  type TaskStateMap,
} from "../src/scheduler.ts";
import type { TaskDescriptor, XmlElement } from "../src/graph.ts";

function el(
  tag: string,
  props: Record<string, string> = {},
  children: XmlElement[] = [],
): XmlElement {
  return { kind: "element", tag, props, children };
}

function desc(
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

function descs(...tasks: TaskDescriptor[]) {
  return new Map(tasks.map((task) => [task.nodeId, task]));
}

describe("scheduler", () => {
  test("buildPlanTree builds sequence and parallel nodes", () => {
    const { plan } = buildPlanTree(
      el("smithers:workflow", {}, [
        el("smithers:task", { id: "first" }),
        el("smithers:parallel", {}, [
          el("smithers:task", { id: "a" }),
          el("smithers:task", { id: "b" }),
        ]),
      ]),
    );

    expect(plan?.kind).toBe("sequence");
    if (plan?.kind === "sequence") {
      expect(plan.children[0]).toEqual({ kind: "task", nodeId: "first" });
      expect(plan.children[1].kind).toBe("parallel");
    }
  });

  test("schedules sequence one task at a time", () => {
    const plan: PlanNode = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states: TaskStateMap = new Map();
    const result = scheduleTasks(
      plan,
      states,
      descs(desc("a"), desc("b")),
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((task) => task.nodeId)).toEqual(["a"]);
  });

  test("respects dependency and group concurrency limits", () => {
    const plan: PlanNode = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
        { kind: "task", nodeId: "c" },
      ],
    };
    const states: TaskStateMap = new Map([[buildStateKey("a", 0), "in-progress"]]);
    const result = scheduleTasks(
      plan,
      states,
      descs(
        desc("a", { parallelGroupId: "g", parallelMaxConcurrency: 2 }),
        desc("b", { parallelGroupId: "g", parallelMaxConcurrency: 2 }),
        desc("c", {
          dependsOn: ["a"],
          parallelGroupId: "g",
          parallelMaxConcurrency: 2,
        }),
      ),
      new Map(),
      new Map(),
      Date.now(),
    );

    expect(result.runnable.map((task) => task.nodeId)).toEqual(["b"]);
  });

  test("schedules parallel branches together when no concurrency cap is hit", () => {
    const result = scheduleTasks(
      {
        kind: "parallel",
        children: [
          { kind: "task", nodeId: "a" },
          { kind: "task", nodeId: "b" },
        ],
      },
      new Map(),
      descs(desc("a"), desc("b")),
      new Map(),
      new Map(),
      Date.now(),
    );

    expect(result.runnable.map((task) => task.nodeId)).toEqual(["a", "b"]);
  });

  test("tracks retry backoff waits", () => {
    const retryAt = 2_000;
    const result = scheduleTasks(
      { kind: "task", nodeId: "a" },
      new Map(),
      descs(desc("a")),
      new Map(),
      new Map([[buildStateKey("a", 0), retryAt]]),
      1_000,
    );

    expect(result.runnable).toEqual([]);
    expect(result.nextRetryAtMs).toBe(retryAt);
  });

  test("detects explicit continuation nodes", () => {
    const result = scheduleTasks(
      { kind: "continue-as-new", stateJson: "{\"ok\":true}" },
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      Date.now(),
    );

    expect(result.continuation).toEqual({ stateJson: "{\"ok\":true}" });
  });

  test("marks a Ralph loop ready after its body is terminal", () => {
    const result = scheduleTasks(
      {
        kind: "ralph",
        id: "loop",
        children: [{ kind: "task", nodeId: "a" }],
        until: false,
        maxIterations: 3,
        onMaxReached: "return-last",
        continueAsNewEvery: 2,
      },
      new Map([[buildStateKey("a", 0), "finished"]]),
      descs(desc("a", { ralphId: "loop" })),
      new Map([["loop", { iteration: 0, done: false }]]),
      new Map(),
      Date.now(),
    );

    expect(result.readyRalphs).toEqual([
      {
        id: "loop",
        until: false,
        maxIterations: 3,
        onMaxReached: "return-last",
        continueAsNewEvery: 2,
      },
    ]);
  });

  test("runs saga compensation and reports fatal compensate-and-fail", () => {
    const result = scheduleTasks(
      {
        kind: "saga",
        id: "saga-1",
        actionChildren: [
          { kind: "task", nodeId: "a" },
          { kind: "task", nodeId: "b" },
        ],
        compensationChildren: [{ kind: "task", nodeId: "undo-a" }],
        onFailure: "compensate-and-fail",
      },
      new Map([
        [buildStateKey("a", 0), "finished"],
        [buildStateKey("b", 0), "failed"],
        [buildStateKey("undo-a", 0), "finished"],
      ]),
      descs(desc("a"), desc("b"), desc("undo-a")),
      new Map(),
      new Map(),
      Date.now(),
    );

    expect(result.fatalError).toBe("Saga saga-1 failed");
  });

  test("executes try-catch-finally catch and finally branches after try failure", () => {
    const first = scheduleTasks(
      {
        kind: "try-catch-finally",
        id: "tcf",
        tryChildren: [{ kind: "task", nodeId: "try" }],
        catchChildren: [{ kind: "task", nodeId: "catch" }],
        finallyChildren: [{ kind: "task", nodeId: "finally" }],
      },
      new Map([[buildStateKey("try", 0), "failed"]]),
      descs(desc("try"), desc("catch"), desc("finally")),
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(first.runnable.map((task) => task.nodeId)).toEqual(["catch"]);

    const second = scheduleTasks(
      {
        kind: "try-catch-finally",
        id: "tcf",
        tryChildren: [{ kind: "task", nodeId: "try" }],
        catchChildren: [{ kind: "task", nodeId: "catch" }],
        finallyChildren: [{ kind: "task", nodeId: "finally" }],
      },
      new Map([
        [buildStateKey("try", 0), "failed"],
        [buildStateKey("catch", 0), "finished"],
      ]),
      descs(desc("try"), desc("catch"), desc("finally")),
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(second.runnable.map((task) => task.nodeId)).toEqual(["finally"]);
  });
});
