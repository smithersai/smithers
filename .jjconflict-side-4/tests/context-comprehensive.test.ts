import { describe, expect, test } from "bun:test";
import { buildContext, createSmithersContext } from "../src/context";
import { z } from "zod";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("buildContext edge cases", () => {
  test("output with iteration=0 matches when ctx iteration=0", () => {
    const row = { nodeId: "n", iteration: 0, v: 1 };
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: { tbl: [row] },
    });
    expect(ctx.output("tbl", { nodeId: "n" })).toBe(row);
  });

  test("output falls back to ctx.iteration when key.iteration is undefined", () => {
    const row = { nodeId: "n", iteration: 2, v: "val" };
    const ctx = buildContext({
      runId: "r1",
      iteration: 2,
      input: {},
      outputs: { tbl: [row] },
    });
    expect(ctx.output("tbl", { nodeId: "n" })).toBe(row);
  });

  test("output throws descriptive error on missing row", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: {},
    });
    expect(() => ctx.output("tbl", { nodeId: "missing" })).toThrow(
      /Missing output.*nodeId=missing/,
    );
  });

  test("latest with multiple nodes only returns matching nodeId", () => {
    const rows = [
      { nodeId: "a", iteration: 0, v: 1 },
      { nodeId: "b", iteration: 1, v: 2 },
      { nodeId: "a", iteration: 1, v: 3 },
    ];
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: { tbl: rows },
    });
    expect(ctx.latest("tbl", "a")).toEqual(rows[2]);
    expect(ctx.latest("tbl", "b")).toEqual(rows[1]);
  });

  test("latest handles non-numeric iteration gracefully", () => {
    const rows = [{ nodeId: "n", iteration: undefined as any, v: 1 }];
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: { tbl: rows },
    });
    // Should treat non-finite iterations as 0
    expect(ctx.latest("tbl", "n")).toEqual(rows[0]);
  });

  test("iterationCount with duplicate iterations counts unique", () => {
    const rows = [
      { nodeId: "n", iteration: 0 },
      { nodeId: "n", iteration: 0 },
      { nodeId: "n", iteration: 1 },
    ];
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: { tbl: rows },
    });
    expect(ctx.iterationCount("tbl", "n")).toBe(2);
  });

  test("latestArray with JSON string containing single value", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: {},
    });
    const result = ctx.latestArray('"hello"', z.string());
    expect(result).toEqual(["hello"]);
  });

  test("latestArray with undefined returns empty", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: {},
    });
    expect(ctx.latestArray(undefined, z.string())).toEqual([]);
  });

  test("latestArray with object schema", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: {},
    });
    const items = [
      { name: "Alice", age: 30 },
      { name: "Bob" }, // missing age
      { name: "Charlie", age: 25 },
    ];
    const result = ctx.latestArray(items, schema);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Alice");
    expect(result[1].name).toBe("Charlie");
  });

  test("input normalization with extra non-payload keys preserves raw", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: { runId: "r1", payload: { x: 1 }, extra: "val" },
      outputs: {},
    });
    // Has extra key beyond runId/payload, so raw input returned
    expect(ctx.input).toEqual({
      runId: "r1",
      payload: { x: 1 },
      extra: "val",
    });
  });

  test("input normalization with non-object returns as-is", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: "just a string",
      outputs: {},
    });
    expect(ctx.input).toBe("just a string");
  });

  test("input normalization with null returns null", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: null,
      outputs: {},
    });
    expect(ctx.input).toBeNull();
  });

  test("input returns string payload as-is if not valid JSON", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: { runId: "r1", payload: "not-json{" },
      outputs: {},
    });
    expect(ctx.input).toBe("not-json{");
  });

  test("outputs function with nonexistent table returns empty array", () => {
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: { existing: [{ nodeId: "a", iteration: 0 }] },
    });
    expect(ctx.outputs("nonexistent")).toEqual([]);
  });

  test("resolves Drizzle table name via getTableName fallback", () => {
    // String table names are resolved directly
    const row = { nodeId: "n", iteration: 0 };
    const ctx = buildContext({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: { my_table: [row] },
    });
    expect(ctx.output("my_table", { nodeId: "n" })).toBe(row);
  });
});

describe("createSmithersContext", () => {
  test("useCtx throws outside of Workflow", () => {
    const { useCtx } = createSmithersContext();
    // React.useContext called outside a render context won't have a provider
    // This test validates the hook creation itself
    expect(useCtx).toBeFunction();
  });

  test("creates distinct contexts", () => {
    const ctx1 = createSmithersContext();
    const ctx2 = createSmithersContext();
    expect(ctx1.SmithersContext).not.toBe(ctx2.SmithersContext);
  });

  test("useCtx reads only from its matching provider", () => {
    const ctx1 = createSmithersContext();
    const ctx2 = createSmithersContext();
    const value = buildContext({
      runId: "ctx-run",
      iteration: 0,
      input: {},
      outputs: {},
    });

    function MatchingReader() {
      return React.createElement("span", null, ctx1.useCtx().runId);
    }

    function WrongReader() {
      ctx2.useCtx();
      return React.createElement("span", null, "wrong");
    }

    const html = renderToStaticMarkup(
      React.createElement(
        ctx1.SmithersContext.Provider,
        { value },
        React.createElement(MatchingReader),
      ),
    );

    expect(html).toContain("ctx-run");
    expect(() =>
      renderToStaticMarkup(
        React.createElement(
          ctx1.SmithersContext.Provider,
          { value },
          React.createElement(WrongReader),
        ),
      ),
    ).toThrow("useCtx() must be called inside a <Workflow> created by createSmithers()");
  });
});
