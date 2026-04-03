import { describe, expect, test } from "bun:test";
import {
  buildPlanTree,
  scheduleTasks,
  buildStateKey,
  type TaskStateMap,
  type RalphStateMap,
} from "../src/engine/scheduler";
import type { TaskDescriptor } from "../src/TaskDescriptor";
import { el } from "./helpers";

function makeDesc(
  nodeId: string,
  overrides?: Partial<TaskDescriptor>,
): TaskDescriptor {
  return {
    nodeId,
    ordinal: 0,
    iteration: 0,
    dependsOn: undefined,
    outputTable: null,
    outputTableName: "",
    needsApproval: false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    continueOnFail: false,
    ...overrides,
  } as TaskDescriptor;
}

describe("scheduler group concurrency", () => {
  test("limits tasks admitted per parallel group", () => {
    // Two tasks in the same group with maxConcurrency=1
    const plan = {
      kind: "parallel" as const,
      children: [
        { kind: "task" as const, nodeId: "a" },
        { kind: "task" as const, nodeId: "b" },
      ],
    };

    const states: TaskStateMap = new Map();
    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set(
      "a",
      makeDesc("a", {
        parallelGroupId: "group-1",
        parallelMaxConcurrency: 1,
      }),
    );
    descriptors.set(
      "b",
      makeDesc("b", {
        parallelGroupId: "group-1",
        parallelMaxConcurrency: 1,
      }),
    );

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      new Map(),
      Date.now(),
    );

    // Only 1 task should be admitted since maxConcurrency=1
    expect(result.runnable.length).toBe(1);
    expect(result.pendingExists).toBe(true);
  });

  test("admits multiple tasks when concurrency allows", () => {
    const plan = {
      kind: "parallel" as const,
      children: [
        { kind: "task" as const, nodeId: "a" },
        { kind: "task" as const, nodeId: "b" },
        { kind: "task" as const, nodeId: "c" },
      ],
    };

    const states: TaskStateMap = new Map();
    const descriptors = new Map<string, TaskDescriptor>();
    for (const id of ["a", "b", "c"]) {
      descriptors.set(
        id,
        makeDesc(id, {
          parallelGroupId: "group-1",
          parallelMaxConcurrency: 2,
        }),
      );
    }

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      new Map(),
      Date.now(),
    );

    expect(result.runnable.length).toBe(2);
  });

  test("respects in-progress tasks for group capacity", () => {
    const plan = {
      kind: "parallel" as const,
      children: [
        { kind: "task" as const, nodeId: "a" },
        { kind: "task" as const, nodeId: "b" },
      ],
    };

    const states: TaskStateMap = new Map();
    // "a" is already in-progress
    states.set(buildStateKey("a", 0), "in-progress");

    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set(
      "a",
      makeDesc("a", {
        parallelGroupId: "g1",
        parallelMaxConcurrency: 1,
      }),
    );
    descriptors.set(
      "b",
      makeDesc("b", {
        parallelGroupId: "g1",
        parallelMaxConcurrency: 1,
      }),
    );

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      new Map(),
      Date.now(),
    );

    // "a" in-progress takes the single slot; "b" should not be admitted
    expect(result.runnable.length).toBe(0);
    expect(result.pendingExists).toBe(true);
  });
});

describe("scheduler dependency satisfaction", () => {
  test("task with satisfied dependency is runnable", () => {
    const plan = {
      kind: "sequence" as const,
      children: [
        { kind: "task" as const, nodeId: "a" },
        { kind: "task" as const, nodeId: "b" },
      ],
    };

    const states: TaskStateMap = new Map();
    states.set(buildStateKey("a", 0), "finished");

    const descA = makeDesc("a");
    const descB = makeDesc("b", { dependsOn: ["a"] });
    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set("a", descA);
    descriptors.set("b", descB);

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      new Map(),
      Date.now(),
    );

    expect(result.runnable.map((d) => d.nodeId)).toContain("b");
  });

  test("failed dependency with continueOnFail allows dependent", () => {
    const plan = {
      kind: "sequence" as const,
      children: [
        { kind: "task" as const, nodeId: "a" },
        { kind: "task" as const, nodeId: "b" },
      ],
    };

    const states: TaskStateMap = new Map();
    states.set(buildStateKey("a", 0), "failed");

    const descA = makeDesc("a", { continueOnFail: true });
    const descB = makeDesc("b", { dependsOn: ["a"] });
    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set("a", descA);
    descriptors.set("b", descB);

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      new Map(),
      Date.now(),
    );

    // "a" failed but has continueOnFail, so it's terminal → "b" can proceed
    expect(result.runnable.map((d) => d.nodeId)).toContain("b");
  });

  test("failed dependency without continueOnFail blocks dependent", () => {
    const plan = {
      kind: "sequence" as const,
      children: [
        { kind: "task" as const, nodeId: "a" },
        { kind: "task" as const, nodeId: "b" },
      ],
    };

    const states: TaskStateMap = new Map();
    states.set(buildStateKey("a", 0), "failed");

    const descA = makeDesc("a", { continueOnFail: false });
    const descB = makeDesc("b", { dependsOn: ["a"] });
    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set("a", descA);
    descriptors.set("b", descB);

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      new Map(),
      Date.now(),
    );

    expect(result.runnable.map((d) => d.nodeId)).not.toContain("b");
  });
});

describe("scheduler retry wait", () => {
  test("defers task until retry wait expires", () => {
    const plan = { kind: "task" as const, nodeId: "a" };
    const states: TaskStateMap = new Map();
    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set("a", makeDesc("a"));

    const now = 1000;
    const retryWait = new Map<string, number>();
    retryWait.set(buildStateKey("a", 0), 2000); // retry at 2000ms

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      retryWait,
      now,
    );

    expect(result.runnable.length).toBe(0);
    expect(result.nextRetryAtMs).toBe(2000);
    expect(result.pendingExists).toBe(true);
  });

  test("admits task when retry wait has passed", () => {
    const plan = { kind: "task" as const, nodeId: "a" };
    const states: TaskStateMap = new Map();
    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set("a", makeDesc("a"));

    const now = 3000;
    const retryWait = new Map<string, number>();
    retryWait.set(buildStateKey("a", 0), 2000); // retry at 2000ms, now is 3000

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      retryWait,
      now,
    );

    expect(result.runnable.length).toBe(1);
  });

  test("nextRetryAtMs picks earliest retry time", () => {
    const plan = {
      kind: "parallel" as const,
      children: [
        { kind: "task" as const, nodeId: "a" },
        { kind: "task" as const, nodeId: "b" },
      ],
    };

    const states: TaskStateMap = new Map();
    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set("a", makeDesc("a"));
    descriptors.set("b", makeDesc("b"));

    const retryWait = new Map<string, number>();
    retryWait.set(buildStateKey("a", 0), 5000);
    retryWait.set(buildStateKey("b", 0), 3000);

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      retryWait,
      1000,
    );

    expect(result.nextRetryAtMs).toBe(3000);
  });
});

describe("buildPlanTree error cases", () => {
  test("throws NESTED_LOOP for nested ralph", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:ralph", { id: "outer", until: "false" }, [
        el("smithers:ralph", { id: "inner", until: "false" }, [
          el("smithers:task", { id: "t1" }),
        ]),
      ]),
    ]);

    expect(() => buildPlanTree(xml)).toThrow("Nested <Ralph>");
  });

  test("throws DUPLICATE_ID for duplicate ralph ids", () => {
    // Two ralphs with the same id at the same level
    const xml = el("smithers:workflow", {}, [
      el("smithers:ralph", { id: "loop1", until: "false" }, [
        el("smithers:task", { id: "t1" }),
      ]),
      el("smithers:ralph", { id: "loop1", until: "false" }, [
        el("smithers:task", { id: "t2" }),
      ]),
    ]);

    expect(() => buildPlanTree(xml)).toThrow("Duplicate Ralph id");
  });

  test("returns null plan for null input", () => {
    const { plan, ralphs } = buildPlanTree(null);
    expect(plan).toBeNull();
    expect(ralphs).toEqual([]);
  });

  test("builds sequence plan for workflow", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:task", { id: "t1" }),
      el("smithers:task", { id: "t2" }),
    ]);
    const { plan } = buildPlanTree(xml);
    expect(plan).toBeDefined();
    expect(plan!.kind).toBe("sequence");
  });

  test("builds parallel plan", () => {
    const xml = el("smithers:parallel", {}, [
      el("smithers:task", { id: "t1" }),
      el("smithers:task", { id: "t2" }),
    ]);
    const { plan } = buildPlanTree(xml);
    expect(plan!.kind).toBe("parallel");
  });

  test("extracts ralph metadata", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:ralph", { id: "myloop", until: "false", maxIterations: "10", onMaxReached: "fail" }, [
        el("smithers:task", { id: "t1" }),
      ]),
    ]);
    const { ralphs } = buildPlanTree(xml);
    expect(ralphs.length).toBe(1);
    expect(ralphs[0].id).toBe("myloop");
    expect(ralphs[0].until).toBe(false);
    expect(ralphs[0].maxIterations).toBe(10);
    expect(ralphs[0].onMaxReached).toBe("fail");
  });

  test("ralph defaults maxIterations to 5 and onMaxReached to return-last", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:ralph", { id: "loop", until: "false" }, [
        el("smithers:task", { id: "t1" }),
      ]),
    ]);
    const { ralphs } = buildPlanTree(xml);
    expect(ralphs[0].maxIterations).toBe(5);
    expect(ralphs[0].onMaxReached).toBe("return-last");
  });
});

describe("scheduler ralph loop termination", () => {
  test("ralph with until=true is terminal", () => {
    const plan = {
      kind: "ralph" as const,
      id: "loop1",
      children: [{ kind: "task" as const, nodeId: "t1" }],
      until: true,
      maxIterations: 5,
      onMaxReached: "return-last" as const,
    };

    const states: TaskStateMap = new Map();
    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set("t1", makeDesc("t1"));

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      new Map(),
      Date.now(),
    );

    // until=true means the loop is done, no tasks should run
    expect(result.runnable.length).toBe(0);
  });

  test("ralph with done=true in state is terminal", () => {
    const plan = {
      kind: "ralph" as const,
      id: "loop1",
      children: [{ kind: "task" as const, nodeId: "t1" }],
      until: false,
      maxIterations: 5,
      onMaxReached: "return-last" as const,
    };

    const states: TaskStateMap = new Map();
    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set("t1", makeDesc("t1"));

    const ralphState: RalphStateMap = new Map();
    ralphState.set("loop1", { iteration: 3, done: true });

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      ralphState,
      new Map(),
      Date.now(),
    );

    expect(result.runnable.length).toBe(0);
  });

  test("completed ralph iteration yields readyRalphs", () => {
    const plan = {
      kind: "ralph" as const,
      id: "loop1",
      children: [{ kind: "task" as const, nodeId: "t1" }],
      until: false,
      maxIterations: 5,
      onMaxReached: "return-last" as const,
    };

    const states: TaskStateMap = new Map();
    states.set(buildStateKey("t1", 0), "finished");

    const descriptors = new Map<string, TaskDescriptor>();
    descriptors.set("t1", makeDesc("t1"));

    const result = scheduleTasks(
      plan,
      states,
      descriptors,
      new Map(),
      new Map(),
      Date.now(),
    );

    expect(result.readyRalphs.length).toBe(1);
    expect(result.readyRalphs[0].id).toBe("loop1");
  });
});

describe("buildStateKey", () => {
  test("constructs key from nodeId and iteration", () => {
    expect(buildStateKey("task-1", 0)).toBe("task-1::0");
    expect(buildStateKey("task-2", 5)).toBe("task-2::5");
  });
});
