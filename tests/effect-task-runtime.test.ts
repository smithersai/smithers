import { describe, expect, test } from "bun:test";
import { withTaskRuntime, getTaskRuntime, requireTaskRuntime } from "../src/effect/task-runtime";

describe("task runtime", () => {
  test("getTaskRuntime returns undefined outside context", () => {
    expect(getTaskRuntime()).toBeUndefined();
  });

  test("requireTaskRuntime throws outside context", () => {
    expect(() => requireTaskRuntime()).toThrow("task runtime is only available");
  });

  test("withTaskRuntime provides runtime to callback", () => {
    const runtime = {
      runId: "run-1",
      stepId: "step-1",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: null,
      heartbeat: () => {},
      lastHeartbeat: null,
    };
    const result = withTaskRuntime(runtime, () => {
      const rt = getTaskRuntime();
      return rt?.runId;
    });
    expect(result).toBe("run-1");
  });

  test("requireTaskRuntime returns runtime inside context", () => {
    const runtime = {
      runId: "run-2",
      stepId: "step-2",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: null,
      heartbeat: () => {},
      lastHeartbeat: null,
    };
    withTaskRuntime(runtime, () => {
      const rt = requireTaskRuntime();
      expect(rt.runId).toBe("run-2");
      expect(rt.stepId).toBe("step-2");
    });
  });

  test("context is isolated between calls", () => {
    const rt1 = {
      runId: "run-a",
      stepId: "step-a",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: null,
      heartbeat: () => {},
      lastHeartbeat: null,
    };
    const rt2 = {
      runId: "run-b",
      stepId: "step-b",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: null,
      heartbeat: () => {},
      lastHeartbeat: null,
    };
    withTaskRuntime(rt1, () => {
      expect(requireTaskRuntime().runId).toBe("run-a");
    });
    withTaskRuntime(rt2, () => {
      expect(requireTaskRuntime().runId).toBe("run-b");
    });
  });

  test("context is not available after withTaskRuntime completes", () => {
    const runtime = {
      runId: "run-3",
      stepId: "step-3",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: null,
      heartbeat: () => {},
      lastHeartbeat: null,
    };
    withTaskRuntime(runtime, () => {
      expect(getTaskRuntime()).toBeDefined();
    });
    expect(getTaskRuntime()).toBeUndefined();
  });

  test("nested contexts shadow outer", () => {
    const outer = {
      runId: "outer",
      stepId: "outer-step",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: null,
      heartbeat: () => {},
      lastHeartbeat: null,
    };
    const inner = {
      runId: "inner",
      stepId: "inner-step",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: null,
      heartbeat: () => {},
      lastHeartbeat: null,
    };
    withTaskRuntime(outer, () => {
      expect(requireTaskRuntime().runId).toBe("outer");
      withTaskRuntime(inner, () => {
        expect(requireTaskRuntime().runId).toBe("inner");
      });
      expect(requireTaskRuntime().runId).toBe("outer");
    });
  });

  test("async context propagation", async () => {
    const runtime = {
      runId: "async-run",
      stepId: "async-step",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db: null,
      heartbeat: () => {},
      lastHeartbeat: null,
    };
    const result = await withTaskRuntime(runtime, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return requireTaskRuntime().runId;
    });
    expect(result).toBe("async-run");
  });
});
