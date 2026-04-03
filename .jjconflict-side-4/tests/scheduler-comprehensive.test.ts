import { describe, expect, test } from "bun:test";
import {
  buildPlanTree,
  scheduleTasks,
  buildStateKey,
  type PlanNode,
  type TaskStateMap,
  type RalphStateMap,
} from "../src/engine/scheduler";
import type { TaskDescriptor } from "../src/TaskDescriptor";
import { el } from "./helpers";

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
    outputRef: undefined,
    outputSchema: undefined,
    dependsOn: undefined,
    needs: undefined,
    needsApproval: false,
    approvalMode: "gate",
    approvalOnDeny: undefined,
    skipIf: false,
    retries: 0,
    retryPolicy: undefined,
    timeoutMs: null,
    continueOnFail: false,
    cachePolicy: undefined,
    agent: undefined,
    prompt: undefined,
    staticPayload: undefined,
    computeFn: undefined,
    label: undefined,
    meta: undefined,
    parallelGroupId: undefined,
    parallelMaxConcurrency: undefined,
    ...overrides,
  };
}

function makeDescMap(...descs: TaskDescriptor[]): Map<string, TaskDescriptor> {
  const map = new Map<string, TaskDescriptor>();
  for (const d of descs) map.set(d.nodeId, d);
  return map;
}

describe("buildPlanTree", () => {
  test("returns null plan for null input", () => {
    const result = buildPlanTree(null);
    expect(result.plan).toBeNull();
    expect(result.ralphs).toEqual([]);
  });

  test("ignores text nodes", () => {
    const result = buildPlanTree({ kind: "text", text: "hello" });
    expect(result.plan).toBeNull();
  });

  test("builds sequence from workflow", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:task", { id: "t1" }),
      el("smithers:task", { id: "t2" }),
    ]);
    const { plan } = buildPlanTree(xml);
    expect(plan).toBeDefined();
    expect(plan!.kind).toBe("sequence");
    if (plan!.kind === "sequence") {
      expect(plan!.children).toHaveLength(2);
      expect(plan!.children[0]).toEqual({ kind: "task", nodeId: "t1" });
      expect(plan!.children[1]).toEqual({ kind: "task", nodeId: "t2" });
    }
  });

  test("builds parallel node", () => {
    const xml = el("smithers:parallel", {}, [
      el("smithers:task", { id: "a" }),
      el("smithers:task", { id: "b" }),
    ]);
    const { plan } = buildPlanTree(xml);
    expect(plan!.kind).toBe("parallel");
  });

  test("builds ralph node with default maxIterations", () => {
    const xml = el("smithers:ralph", { id: "loop1" }, [
      el("smithers:task", { id: "t1" }),
    ]);
    const { plan, ralphs } = buildPlanTree(xml);
    expect(plan!.kind).toBe("ralph");
    expect(ralphs).toHaveLength(1);
    expect(ralphs[0].id).toBe("loop1");
    expect(ralphs[0].maxIterations).toBe(5);
    expect(ralphs[0].onMaxReached).toBe("return-last");
  });

  test("ralph custom maxIterations", () => {
    const xml = el("smithers:ralph", { id: "r", maxIterations: "10" }, [
      el("smithers:task", { id: "t1" }),
    ]);
    const { ralphs } = buildPlanTree(xml);
    expect(ralphs[0].maxIterations).toBe(10);
  });

  test("ralph onMaxReached=fail", () => {
    const xml = el("smithers:ralph", { id: "r", onMaxReached: "fail" }, [
      el("smithers:task", { id: "t1" }),
    ]);
    const { ralphs } = buildPlanTree(xml);
    expect(ralphs[0].onMaxReached).toBe("fail");
  });

  test("throws on nested ralph", () => {
    const xml = el("smithers:ralph", { id: "outer" }, [
      el("smithers:ralph", { id: "inner" }, [
        el("smithers:task", { id: "t1" }),
      ]),
    ]);
    expect(() => buildPlanTree(xml)).toThrow("Nested <Ralph>");
  });

  test("throws on duplicate ralph id", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:ralph", { id: "dup" }, [el("smithers:task", { id: "t1" })]),
      el("smithers:ralph", { id: "dup" }, [el("smithers:task", { id: "t2" })]),
    ]);
    expect(() => buildPlanTree(xml)).toThrow("Duplicate Ralph id");
  });

  test("skips task without id", () => {
    const xml = el("smithers:task", {});
    const { plan } = buildPlanTree(xml);
    expect(plan).toBeNull();
  });

  test("merge-queue treated as parallel", () => {
    const xml = el("smithers:merge-queue", {}, [
      el("smithers:task", { id: "t1" }),
    ]);
    const { plan } = buildPlanTree(xml);
    expect(plan!.kind).toBe("parallel");
  });

  test("worktree treated as group", () => {
    const xml = el("smithers:worktree", {}, [
      el("smithers:task", { id: "t1" }),
    ]);
    const { plan } = buildPlanTree(xml);
    expect(plan!.kind).toBe("group");
  });

  test("unknown tag treated as group", () => {
    const xml = el("div", {}, [el("smithers:task", { id: "t1" })]);
    const { plan } = buildPlanTree(xml);
    expect(plan!.kind).toBe("group");
  });

  test("sequence nests correctly", () => {
    const xml = el("smithers:sequence", {}, [
      el("smithers:sequence", {}, [
        el("smithers:task", { id: "t1" }),
        el("smithers:task", { id: "t2" }),
      ]),
      el("smithers:task", { id: "t3" }),
    ]);
    const { plan } = buildPlanTree(xml);
    expect(plan!.kind).toBe("sequence");
    if (plan!.kind === "sequence") {
      expect(plan!.children[0].kind).toBe("sequence");
      expect(plan!.children[1]).toEqual({ kind: "task", nodeId: "t3" });
    }
  });
});

describe("scheduleTasks", () => {
  test("schedules pending tasks in sequence order", () => {
    const plan: PlanNode = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states: TaskStateMap = new Map();
    const descs = makeDescMap(desc("a"), desc("b"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a"]);
    expect(result.pendingExists).toBe(true);
  });

  test("schedules next in sequence after first finishes", () => {
    const plan: PlanNode = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "finished"],
    ]);
    const descs = makeDescMap(desc("a"), desc("b"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["b"]);
  });

  test("schedules all parallel children", () => {
    const plan: PlanNode = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
        { kind: "task", nodeId: "c" },
      ],
    };
    const states: TaskStateMap = new Map();
    const descs = makeDescMap(desc("a"), desc("b"), desc("c"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a", "b", "c"]);
  });

  test("parallel terminal only when all children terminal", () => {
    const plan: PlanNode = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "finished"],
    ]);
    const descs = makeDescMap(desc("a"), desc("b"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["b"]);
  });

  test("failed task is terminal when continueOnFail is true", () => {
    const plan: PlanNode = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "failed"],
    ]);
    const descs = makeDescMap(desc("a", { continueOnFail: true }), desc("b"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["b"]);
  });

  test("failed task blocks sequence when continueOnFail is false", () => {
    const plan: PlanNode = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "failed"],
    ]);
    const descs = makeDescMap(desc("a", { continueOnFail: false }), desc("b"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable).toEqual([]);
  });

  test("skipped task is terminal", () => {
    const plan: PlanNode = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "skipped"],
    ]);
    const descs = makeDescMap(desc("a"), desc("b"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["b"]);
  });

  test("waiting-approval is tracked", () => {
    const plan: PlanNode = { kind: "task", nodeId: "a" };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "waiting-approval"],
    ]);
    const descs = makeDescMap(desc("a"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.waitingApprovalExists).toBe(true);
    expect(result.runnable).toEqual([]);
  });

  test("retryWait prevents scheduling until time elapsed", () => {
    const plan: PlanNode = { kind: "task", nodeId: "a" };
    const states: TaskStateMap = new Map();
    const descs = makeDescMap(desc("a"));
    const now = Date.now();
    const retryWait = new Map([[buildStateKey("a", 0), now + 10000]]);
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      retryWait,
      now,
    );
    expect(result.runnable).toEqual([]);
    expect(result.nextRetryAtMs).toBe(now + 10000);
  });

  test("retryWait allows scheduling when time has passed", () => {
    const plan: PlanNode = { kind: "task", nodeId: "a" };
    const states: TaskStateMap = new Map();
    const descs = makeDescMap(desc("a"));
    const retryAt = Date.now() - 1000;
    const retryWait = new Map([[buildStateKey("a", 0), retryAt]]);
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      retryWait,
      Date.now(),
    );
    expect(result.runnable).toHaveLength(1);
  });

  test("dependencies must be satisfied before scheduling", () => {
    const plan: PlanNode = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states: TaskStateMap = new Map();
    const descs = makeDescMap(
      desc("a"),
      desc("b", { dependsOn: ["a"] }),
    );
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a"]);
  });

  test("dependency on finished task allows scheduling", () => {
    const plan: PlanNode = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "finished"],
    ]);
    const descs = makeDescMap(
      desc("a"),
      desc("b", { dependsOn: ["a"] }),
    );
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["b"]);
  });

  test("ralph is not terminal when until is false and not done", () => {
    const plan: PlanNode = {
      kind: "ralph",
      id: "loop",
      children: [{ kind: "task", nodeId: "t1" }],
      until: false,
      maxIterations: 5,
      onMaxReached: "return-last",
    };
    const states: TaskStateMap = new Map();
    const descs = makeDescMap(desc("t1"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["t1"]);
  });

  test("ralph is terminal when until is true", () => {
    const plan: PlanNode = {
      kind: "ralph",
      id: "loop",
      children: [{ kind: "task", nodeId: "t1" }],
      until: true,
      maxIterations: 5,
      onMaxReached: "return-last",
    };
    const states: TaskStateMap = new Map();
    const descs = makeDescMap(desc("t1"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable).toEqual([]);
  });

  test("ralph pushes readyRalphs when children are all terminal", () => {
    const plan: PlanNode = {
      kind: "ralph",
      id: "loop",
      children: [{ kind: "task", nodeId: "t1" }],
      until: false,
      maxIterations: 5,
      onMaxReached: "return-last",
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("t1", 0), "finished"],
    ]);
    const descs = makeDescMap(desc("t1"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.readyRalphs).toHaveLength(1);
    expect(result.readyRalphs[0].id).toBe("loop");
  });

  test("group concurrency limits admissions", () => {
    const plan: PlanNode = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
        { kind: "task", nodeId: "c" },
      ],
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "in-progress"],
    ]);
    const groupId = "g1";
    const descs = makeDescMap(
      desc("a", { parallelGroupId: groupId, parallelMaxConcurrency: 2 }),
      desc("b", { parallelGroupId: groupId, parallelMaxConcurrency: 2 }),
      desc("c", { parallelGroupId: groupId, parallelMaxConcurrency: 2 }),
    );
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    // Only 1 more should be admitted (2 max - 1 in-progress = 1)
    expect(result.runnable).toHaveLength(1);
    expect(result.runnable[0].nodeId).toBe("b");
  });

  test("cancelled task can be rescheduled", () => {
    const plan: PlanNode = { kind: "task", nodeId: "a" };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "cancelled"],
    ]);
    const descs = makeDescMap(desc("a"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable).toHaveLength(1);
    expect(result.pendingExists).toBe(true);
  });

  test("null plan returns empty result", () => {
    const result = scheduleTasks(
      null,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(false);
    expect(result.waitingApprovalExists).toBe(false);
  });

  test("buildStateKey creates correct format", () => {
    expect(buildStateKey("myNode", 3)).toBe("myNode::3");
    expect(buildStateKey("a", 0)).toBe("a::0");
  });

  test("sequence fast-forwards through multiple finished children", () => {
    // Simulates hot-reload catch-up: many children are already finished,
    // the scheduler should skip past all of them in a single pass and
    // schedule the first pending child.
    const plan: PlanNode = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
        { kind: "task", nodeId: "c" },
        { kind: "task", nodeId: "d" },
        { kind: "task", nodeId: "e" },
      ],
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "finished"],
      [buildStateKey("b", 0), "finished"],
      [buildStateKey("c", 0), "finished"],
      [buildStateKey("d", 0), "finished"],
    ]);
    const descs = makeDescMap(
      desc("a"),
      desc("b"),
      desc("c"),
      desc("d"),
      desc("e"),
    );
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["e"]);
    expect(result.pendingExists).toBe(true);
  });

  test("sequence completes when all children are already finished", () => {
    // After hot-reload, all tasks in the sequence may already be done.
    // The scheduler should report no runnable and no pending.
    const plan: PlanNode = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
        { kind: "task", nodeId: "c" },
      ],
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "finished"],
      [buildStateKey("b", 0), "finished"],
      [buildStateKey("c", 0), "finished"],
    ]);
    const descs = makeDescMap(desc("a"), desc("b"), desc("c"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(false);
  });

  test("sequence fast-forwards through mixed finished and skipped children", () => {
    const plan: PlanNode = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
        { kind: "task", nodeId: "c" },
      ],
    };
    const states: TaskStateMap = new Map([
      [buildStateKey("a", 0), "finished"],
      [buildStateKey("b", 0), "skipped"],
    ]);
    const descs = makeDescMap(desc("a"), desc("b"), desc("c"));
    const result = scheduleTasks(
      plan,
      states,
      descs,
      new Map(),
      new Map(),
      Date.now(),
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["c"]);
  });
});
