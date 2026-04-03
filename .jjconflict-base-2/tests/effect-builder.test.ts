import { describe, expect, test } from "bun:test";
import { Layer } from "effect";
import { Smithers } from "../src/index";
import type { BuilderStepHandle, BuilderNode } from "../src/effect/builder";

// The builder module's internal functions (durationToMs, deriveRetryCount,
// createBuilder, etc.) are private. We test their behavior via the TOON
// loadToon API and via the observable type shapes.

// ---------------------------------------------------------------------------
// Smithers.sqlite — Layer factory
// ---------------------------------------------------------------------------

describe("Smithers.sqlite", () => {
  test("returns an Effect Layer", () => {
    const layer = Smithers.sqlite({ filename: ":memory:" });
    expect(layer).toBeDefined();
    // Effect Layer should have a standard shape
    expect(Layer.isLayer(layer)).toBe(true);
  });

  test("accepts custom filename", () => {
    const layer = Smithers.sqlite({ filename: "/tmp/test.db" });
    expect(Layer.isLayer(layer)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Smithers.loadToon — TOON workflow loader
// ---------------------------------------------------------------------------

describe("Smithers.loadToon", () => {
  test("returns a BuiltSmithersWorkflow with execute method", () => {
    // loadToon creates a lazy workflow that reads the file on execute
    const wf = Smithers.loadToon("/nonexistent.toon");
    expect(wf).toBeDefined();
    expect(typeof wf.execute).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// BuilderNode and BuilderStepHandle types — structural tests
// ---------------------------------------------------------------------------

describe("BuilderStepHandle shape", () => {
  test("step handle has correct shape", () => {
    const handle: BuilderStepHandle = {
      kind: "step",
      id: "my-step",
      localId: "my-step",
      tableKey: "my_step",
      tableName: "smithers_my_step",
      table: {},
      output: {},
      needs: {},
      retries: 3,
      timeoutMs: 5000,
      loopId: undefined,
    };

    expect(handle.kind).toBe("step");
    expect(handle.id).toBe("my-step");
    expect(handle.retries).toBe(3);
    expect(handle.timeoutMs).toBe(5000);
  });

  test("approval handle has correct shape", () => {
    const handle: BuilderStepHandle = {
      kind: "approval",
      id: "review",
      localId: "review",
      tableKey: "review",
      tableName: "smithers_review",
      table: {},
      output: {},
      needs: {},
      retries: 0,
      timeoutMs: null,
      onDeny: "fail",
      request: () => ({ title: "Review" }),
    };

    expect(handle.kind).toBe("approval");
    expect(handle.onDeny).toBe("fail");
    expect(handle.timeoutMs).toBeNull();
    expect(handle.retries).toBe(0);
  });

  test("step handle with retry policy", () => {
    const handle: BuilderStepHandle = {
      kind: "step",
      id: "retry-step",
      localId: "retry-step",
      tableKey: "retry_step",
      tableName: "smithers_retry_step",
      table: {},
      output: {},
      needs: {},
      retries: 4,
      retryPolicy: {
        backoff: "exponential",
        initialDelayMs: 1000,
      },
      timeoutMs: 30000,
    };

    expect(handle.retries).toBe(4);
    expect(handle.retryPolicy?.backoff).toBe("exponential");
    expect(handle.retryPolicy?.initialDelayMs).toBe(1000);
    expect(handle.timeoutMs).toBe(30000);
  });

  test("step handle with loop annotation", () => {
    const handle: BuilderStepHandle = {
      kind: "step",
      id: "loop-step",
      localId: "loop-step",
      tableKey: "loop_step",
      tableName: "smithers_loop_step",
      table: {},
      output: {},
      needs: {},
      retries: 0,
      timeoutMs: null,
      loopId: "main-loop",
    };

    expect(handle.loopId).toBe("main-loop");
  });

  test("step handle with cache policy", () => {
    const handle: BuilderStepHandle = {
      kind: "step",
      id: "cached-step",
      localId: "cached-step",
      tableKey: "cached_step",
      tableName: "smithers_cached_step",
      table: {},
      output: {},
      needs: {},
      retries: 0,
      timeoutMs: null,
      cache: { version: "v1" },
    };

    expect(handle.cache).toEqual({ version: "v1" });
  });

  test("step handle with needs dependencies", () => {
    const depHandle: BuilderStepHandle = {
      kind: "step",
      id: "dep-a",
      localId: "dep-a",
      tableKey: "dep_a",
      tableName: "smithers_dep_a",
      table: {},
      output: {},
      needs: {},
      retries: 0,
      timeoutMs: null,
    };

    const handle: BuilderStepHandle = {
      kind: "step",
      id: "main",
      localId: "main",
      tableKey: "main",
      tableName: "smithers_main",
      table: {},
      output: {},
      needs: { dependency: depHandle },
      retries: 0,
      timeoutMs: null,
    };

    expect(handle.needs.dependency).toBe(depHandle);
    expect(handle.needs.dependency.id).toBe("dep-a");
  });
});

// ---------------------------------------------------------------------------
// BuilderNode union type variants
// ---------------------------------------------------------------------------

describe("BuilderNode variants", () => {
  test("sequence node", () => {
    const step1: BuilderStepHandle = {
      kind: "step", id: "a", localId: "a", tableKey: "a",
      tableName: "smithers_a", table: {}, output: {}, needs: {},
      retries: 0, timeoutMs: null,
    };
    const node: BuilderNode = {
      kind: "sequence",
      children: [step1],
    };
    expect(node.kind).toBe("sequence");
    expect((node as any).children).toHaveLength(1);
  });

  test("parallel node with maxConcurrency", () => {
    const step1: BuilderStepHandle = {
      kind: "step", id: "a", localId: "a", tableKey: "a",
      tableName: "smithers_a", table: {}, output: {}, needs: {},
      retries: 0, timeoutMs: null,
    };
    const node: BuilderNode = {
      kind: "parallel",
      children: [step1],
      maxConcurrency: 3,
    };
    expect(node.kind).toBe("parallel");
    expect((node as any).maxConcurrency).toBe(3);
  });

  test("loop node", () => {
    const step1: BuilderStepHandle = {
      kind: "step", id: "a", localId: "a", tableKey: "a",
      tableName: "smithers_a", table: {}, output: {}, needs: {},
      retries: 0, timeoutMs: null,
    };
    const node: BuilderNode = {
      kind: "loop",
      id: "main-loop",
      children: step1,
      until: () => false,
      maxIterations: 10,
      onMaxReached: "return-last",
    };
    expect(node.kind).toBe("loop");
    expect((node as any).maxIterations).toBe(10);
    expect((node as any).onMaxReached).toBe("return-last");
  });

  test("branch node", () => {
    const step1: BuilderStepHandle = {
      kind: "step", id: "a", localId: "a", tableKey: "a",
      tableName: "smithers_a", table: {}, output: {}, needs: {},
      retries: 0, timeoutMs: null,
    };
    const node: BuilderNode = {
      kind: "branch",
      condition: () => true,
      then: step1,
      else: undefined,
    };
    expect(node.kind).toBe("branch");
    expect((node as any).condition()).toBe(true);
  });

  test("worktree node", () => {
    const step1: BuilderStepHandle = {
      kind: "step", id: "a", localId: "a", tableKey: "a",
      tableName: "smithers_a", table: {}, output: {}, needs: {},
      retries: 0, timeoutMs: null,
    };
    const node: BuilderNode = {
      kind: "worktree",
      path: "/tmp/workdir",
      branch: "feature-branch",
      children: step1,
    };
    expect(node.kind).toBe("worktree");
    expect((node as any).path).toBe("/tmp/workdir");
    expect((node as any).branch).toBe("feature-branch");
  });

  test("match node", () => {
    const source: BuilderStepHandle = {
      kind: "step", id: "src", localId: "src", tableKey: "src",
      tableName: "smithers_src", table: {}, output: {}, needs: {},
      retries: 0, timeoutMs: null,
    };
    const thenStep: BuilderStepHandle = {
      kind: "step", id: "then", localId: "then", tableKey: "then",
      tableName: "smithers_then", table: {}, output: {}, needs: {},
      retries: 0, timeoutMs: null,
    };
    const node: BuilderNode = {
      kind: "match",
      source,
      when: (v: any) => v > 5,
      then: thenStep,
    };
    expect(node.kind).toBe("match");
    expect((node as any).when(10)).toBe(true);
    expect((node as any).when(3)).toBe(false);
  });
});
