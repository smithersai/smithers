import { describe, expect, test } from "bun:test";
import { snapshotSerialize } from "../src/snapshotSerializer.js";

describe("snapshotSerialize", () => {
  test("serializes scalars, arrays, objects, null, undefined, booleans", () => {
    expect(snapshotSerialize("abc")).toBe("abc");
    expect(snapshotSerialize(1)).toBe(1);
    expect(snapshotSerialize(true)).toBe(true);
    expect(snapshotSerialize(null)).toBeNull();
    expect(snapshotSerialize(undefined)).toBeUndefined();
    expect(snapshotSerialize([1, "two", false])).toEqual([1, "two", false]);
    expect(snapshotSerialize({ a: 1, b: "two", c: null })).toEqual({
      a: 1,
      b: "two",
      c: null,
    });
  });

  test("passes through large strings (1MB)", () => {
    const large = "x".repeat(1024 * 1024);
    expect(snapshotSerialize(large)).toBe(large);
  });

  test("replaces circular references with [Circular]", () => {
    const value: Record<string, unknown> = { name: "root" };
    value.self = value;
    const out = snapshotSerialize(value) as Record<string, unknown>;
    expect(out.self).toBe("[Circular]");
  });

  test("replaces non-serializable values and never throws", () => {
    const result = snapshotSerialize({
      fn: () => "x",
      sym: Symbol("token"),
      dt: new Date("2026-01-01T00:00:00.000Z"),
      big: BigInt(42),
    }) as Record<string, unknown>;
    expect(result.fn).toBe("[Function]");
    expect(result.sym).toBe("[Symbol: token]");
    expect(result.dt).toBe("[Date: 2026-01-01T00:00:00.000Z]");
    expect(result.big).toBe("[BigInt: 42]");
  });

  test("truncates depth > 100 with [MaxDepth]", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth <= 110; depth += 1) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }
    const serialized = snapshotSerialize(root, { maxDepth: 100 }) as Record<string, unknown>;
    let scan = serialized;
    for (let depth = 0; depth < 100; depth += 1) {
      scan = scan.child as Record<string, unknown>;
    }
    expect(scan.child).toBe("[MaxDepth]");
  });
});
