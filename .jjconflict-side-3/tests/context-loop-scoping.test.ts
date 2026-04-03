import { describe, expect, test } from "bun:test";
import { buildContext } from "../src/context";

describe("context loop scoping", () => {
  test("resolves scoped nodeId via current loop iteration", () => {
    // Simulate a workflow with an outer loop at iteration 2.
    // Tasks inside the loop have nodeIds like "innerTask@@outer=0", "innerTask@@outer=1", etc.
    // When outer iteration is 2, we should match "innerTask@@outer=2".
    const rows = [
      { nodeId: "innerTask@@outer=0", iteration: 0, value: "v0" },
      { nodeId: "innerTask@@outer=1", iteration: 0, value: "v1" },
      { nodeId: "innerTask@@outer=2", iteration: 0, value: "v2" },
    ];
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      iterations: {
        outer: 2,
        "innerTask@@outer=0": 0,
        "innerTask@@outer=2": 0,
      },
      input: {},
      outputs: { tbl: rows },
    });
    // Looking up "innerTask" should resolve to the row scoped to current outer iteration (2)
    const result = ctx.outputMaybe("tbl", { nodeId: "innerTask" });
    expect(result).toBeDefined();
    expect(result.value).toBe("v2");
  });

  test("exact nodeId match takes priority", () => {
    const exactRow = { nodeId: "task1", iteration: 0, value: "exact" };
    const scopedRow = { nodeId: "task1@@loop=0", iteration: 0, value: "scoped" };
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      iterations: { loop: 0 },
      input: {},
      outputs: { tbl: [exactRow, scopedRow] },
    });
    expect(ctx.output("tbl", { nodeId: "task1" })).toBe(exactRow);
  });

  test("returns empty/undefined for unmatched scoped lookup", () => {
    const rows = [
      { nodeId: "task@@loop=0", iteration: 0, value: "old" },
    ];
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      iterations: { loop: 5 }, // Current iteration is 5, no row for loop=5
      input: {},
      outputs: { tbl: rows },
    });
    expect(ctx.outputMaybe("tbl", { nodeId: "task" })).toBeUndefined();
  });

  test("latest picks highest iteration across scoped rows", () => {
    const rows = [
      { nodeId: "task@@loop=1", iteration: 0, value: "iter0" },
      { nodeId: "task@@loop=1", iteration: 1, value: "iter1" },
      { nodeId: "task@@loop=1", iteration: 2, value: "iter2" },
    ];
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      iterations: {
        loop: 1,
        "task@@loop=0": 0,
        "task@@loop=1": 2,
      },
      input: {},
      outputs: { tbl: rows },
    });
    const result = ctx.latest("tbl", "task");
    expect(result).toBeDefined();
    expect(result.value).toBe("iter2");
  });

  test("iterationCount counts scoped rows", () => {
    const rows = [
      { nodeId: "task@@outer=1", iteration: 0 },
      { nodeId: "task@@outer=1", iteration: 1 },
      { nodeId: "task@@outer=0", iteration: 0 },
    ];
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      iterations: {
        outer: 1,
        "task@@outer=0": 0,
        "task@@outer=1": 1,
      },
      input: {},
      outputs: { tbl: rows },
    });
    expect(ctx.iterationCount("tbl", "task")).toBe(2);
  });

  test("no iterations map produces no scopes", () => {
    const rows = [
      { nodeId: "task@@scope=0", iteration: 0, value: "scoped" },
    ];
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: { tbl: rows },
    });
    // Without iterations, "task" won't match "task@@scope=0"
    expect(ctx.outputMaybe("tbl", { nodeId: "task" })).toBeUndefined();
  });

  test("already-scoped lookup uses exact match", () => {
    const rows = [
      { nodeId: "task@@loop=0", iteration: 0, value: "v0" },
      { nodeId: "task@@loop=1", iteration: 0, value: "v1" },
    ];
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      iterations: { loop: 1, "task@@loop=0": 0, "task@@loop=1": 0 },
      input: {},
      outputs: { tbl: rows },
    });
    // Explicitly asking for scoped ID should return exact match
    const result = ctx.output("tbl", { nodeId: "task@@loop=0" });
    expect(result.value).toBe("v0");
  });
});

describe("context input normalization edge cases", () => {
  test("non-object input returned as-is", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: "just a string",
      outputs: {},
    });
    expect(ctx.input).toBe("just a string");
  });

  test("null input returned as-is", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: null,
      outputs: {},
    });
    expect(ctx.input).toBeNull();
  });

  test("object with payload and extra keys not normalized", () => {
    const input = { runId: "r1", payload: { x: 1 }, extraKey: "y" };
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input,
      outputs: {},
    });
    // Extra key means it's not payload-only, so return raw
    expect(ctx.input).toEqual(input);
  });

  test("invalid JSON string payload returned as-is", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: { runId: "r1", payload: "not valid json {" },
      outputs: {},
    });
    expect(ctx.input).toBe("not valid json {");
  });

  test("undefined payload returns empty object", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: { runId: "r1", payload: undefined },
      outputs: {},
    });
    expect(ctx.input).toEqual({});
  });
});
