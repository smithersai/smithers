import { describe, expect, test } from "bun:test";
import { stablePathId, resolveStableId } from "../src/utils/tree-ids";

describe("stablePathId", () => {
  test("generates stable id from path", () => {
    expect(stablePathId("task", [0])).toBe(stablePathId("task", [0]));
    expect(stablePathId("task", [0, 1])).toBe(stablePathId("task", [0, 1]));
  });

  test("different paths produce different ids", () => {
    expect(stablePathId("task", [0])).not.toBe(stablePathId("task", [1]));
    expect(stablePathId("task", [0, 1])).not.toBe(stablePathId("task", [1, 0]));
  });

  test("returns a string", () => {
    expect(typeof stablePathId("task", [0, 1, 2])).toBe("string");
  });
});

describe("resolveStableId", () => {
  test("returns explicit id when provided", () => {
    expect(resolveStableId("my-task", "task", [0, 1])).toBe("my-task");
  });

  test("generates path-based id when no explicit id", () => {
    const id = resolveStableId(undefined, "task", [0, 1]);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("includes kind prefix in generated id", () => {
    const id = resolveStableId(undefined, "ralph", [0]);
    expect(id).toContain("ralph");
  });

  test("returns same id for same path and kind", () => {
    const a = resolveStableId(undefined, "task", [0, 2]);
    const b = resolveStableId(undefined, "task", [0, 2]);
    expect(a).toBe(b);
  });

  test("returns different id for different paths", () => {
    const a = resolveStableId(undefined, "task", [0, 1]);
    const b = resolveStableId(undefined, "task", [0, 2]);
    expect(a).not.toBe(b);
  });
});
