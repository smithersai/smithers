import { describe, expect, test } from "bun:test";
import { SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";
import { z } from "zod";
describe("SmithersCtx", () => {
    test("output throws when row is missing", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
        expect(() => ctx.output("tbl", { nodeId: "x" })).toThrow("Missing output");
    });
    test("output returns matching row", () => {
        const row = { nodeId: "a", iteration: 0, value: 42 };
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { tbl: [row] },
        });
        expect(ctx.output("tbl", { nodeId: "a" })).toBe(row);
    });
    test("output matches explicit iteration over default", () => {
        const row0 = { nodeId: "a", iteration: 0, v: 1 };
        const row1 = { nodeId: "a", iteration: 1, v: 2 };
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { tbl: [row0, row1] },
        });
        expect(ctx.output("tbl", { nodeId: "a", iteration: 1 })).toBe(row1);
    });
    test("outputMaybe returns undefined for missing row", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
        expect(ctx.outputMaybe("tbl", { nodeId: "x" })).toBeUndefined();
    });
    test("outputMaybe returns row when present", () => {
        const row = { nodeId: "n", iteration: 0 };
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { tbl: [row] },
        });
        expect(ctx.outputMaybe("tbl", { nodeId: "n" })).toBe(row);
    });
    test("latest returns highest iteration row", () => {
        const rows = [
            { nodeId: "n", iteration: 0, v: "first" },
            { nodeId: "n", iteration: 2, v: "third" },
            { nodeId: "n", iteration: 1, v: "second" },
        ];
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { tbl: rows },
        });
        expect(ctx.latest("tbl", "n")).toEqual(rows[1]);
    });
    test("latest returns undefined for missing nodeId", () => {
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { tbl: [{ nodeId: "other", iteration: 0 }] },
        });
        expect(ctx.latest("tbl", "missing")).toBeUndefined();
    });
    test("latest returns undefined for empty table", () => {
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { tbl: [] },
        });
        expect(ctx.latest("tbl", "n")).toBeUndefined();
    });
    test("iterationCount counts distinct iterations", () => {
        const rows = [
            { nodeId: "n", iteration: 0 },
            { nodeId: "n", iteration: 1 },
            { nodeId: "n", iteration: 2 },
            { nodeId: "other", iteration: 0 },
        ];
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { tbl: rows },
        });
        expect(ctx.iterationCount("tbl", "n")).toBe(3);
    });
    test("iterationCount returns 0 for missing table", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
        expect(ctx.iterationCount("missing", "n")).toBe(0);
    });
    test("iterationCount returns 0 for missing nodeId", () => {
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { tbl: [{ nodeId: "other", iteration: 0 }] },
        });
        expect(ctx.iterationCount("tbl", "n")).toBe(0);
    });
    test("outputs function returns rows for table key", () => {
        const rows = [{ nodeId: "a", iteration: 0 }];
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { myTable: rows },
        });
        expect(ctx.outputs("myTable")).toEqual(rows);
    });
    test("outputs function returns empty array for missing table", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
        expect(ctx.outputs("missing")).toEqual([]);
    });
    test("outputs has named accessors for each table", () => {
        const rows = [{ nodeId: "a", iteration: 0 }];
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { foo: rows },
        });
        expect(ctx.outputs.foo).toEqual(rows);
    });
    test("input normalizes payload-only rows", () => {
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: { runId: "r1", payload: { topic: "ai" } },
            outputs: {},
        });
        expect(ctx.input).toEqual({ topic: "ai" });
    });
    test("input normalizes JSON string payload", () => {
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: { runId: "r1", payload: '{"topic":"ai"}' },
            outputs: {},
        });
        expect(ctx.input).toEqual({ topic: "ai" });
    });
    test("input returns raw input when no payload key", () => {
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: { topic: "ai" },
            outputs: {},
        });
        expect(ctx.input).toEqual({ topic: "ai" });
    });
    test("input returns empty object for null payload", () => {
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: { runId: "r1", payload: null },
            outputs: {},
        });
        expect(ctx.input).toEqual({});
    });
    test("latestArray parses JSON string into array", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
        const result = ctx.latestArray('[1,2,3]', z.number());
        expect(result).toEqual([1, 2, 3]);
    });
    test("latestArray wraps non-array value", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
        const result = ctx.latestArray(42, z.number());
        expect(result).toEqual([42]);
    });
    test("latestArray returns empty for null", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
        expect(ctx.latestArray(null, z.number())).toEqual([]);
    });
    test("latestArray filters invalid items", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
        const result = ctx.latestArray([1, "bad", 3], z.number());
        expect(result).toEqual([1, 3]);
    });
    test("latestArray returns empty for invalid JSON string", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
        expect(ctx.latestArray("not json", z.number())).toEqual([]);
    });
    test("latestArray handles array value directly", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
        const result = ctx.latestArray([{ a: 1 }, { a: 2 }], z.object({ a: z.number() }));
        expect(result).toEqual([{ a: 1 }, { a: 2 }]);
    });
    test("ctx exposes runId", () => {
        const ctx = new SmithersCtx({ runId: "test-run", iteration: 0, input: {}, outputs: {} });
        expect(ctx.runId).toBe("test-run");
    });
    test("ctx exposes iteration", () => {
        const ctx = new SmithersCtx({ runId: "r1", iteration: 3, input: {}, outputs: {} });
        expect(ctx.iteration).toBe(3);
    });
    test("ctx exposes iterations map", () => {
        const iterations = { "loop-1": 5 };
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            iterations,
            input: {},
            outputs: {},
        });
        expect(ctx.iterations).toBe(iterations);
    });
    test("resolves Zod schema as table via zodToKeyName", () => {
        const schema = z.object({ v: z.number() });
        const zodToKeyName = new Map([[schema, "myOutput"]]);
        const row = { nodeId: "n", iteration: 0, v: 1 };
        const ctx = new SmithersCtx({
            runId: "r1",
            iteration: 0,
            input: {},
            outputs: { myOutput: [row] },
            zodToKeyName,
        });
        expect(ctx.output(schema, { nodeId: "n" })).toBe(row);
    });
});
