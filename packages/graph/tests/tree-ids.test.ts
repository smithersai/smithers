import { describe, expect, test } from "bun:test";
import { stablePathId, resolveStableId } from "../src/utils/tree-ids";

describe("stablePathId", () => {
  test("empty path returns root suffix", () => {
    expect(stablePathId("ralph", [])).toBe("ralph:root");
  });

  test("single element path", () => {
    expect(stablePathId("ralph", [0])).toBe("ralph:0");
  });

  test("multi element path joined with dots", () => {
    expect(stablePathId("ralph", [1, 2, 3])).toBe("ralph:1.2.3");
  });

  test("different prefix", () => {
    expect(stablePathId("worktree", [0, 1])).toBe("worktree:0.1");
  });
});

describe("resolveStableId", () => {
  test("uses explicit string id when provided", () => {
    expect(resolveStableId("my-id", "ralph", [0, 1])).toBe("my-id");
  });

  test("ignores empty string explicit id", () => {
    expect(resolveStableId("", "ralph", [0])).toBe("ralph:0");
  });

  test("ignores whitespace-only explicit id", () => {
    expect(resolveStableId("   ", "ralph", [1])).toBe("ralph:1");
  });

  test("falls back to stablePathId for null", () => {
    expect(resolveStableId(null, "worktree", [2, 3])).toBe("worktree:2.3");
  });

  test("falls back to stablePathId for undefined", () => {
    expect(resolveStableId(undefined, "parallel", [0])).toBe("parallel:0");
  });

  test("falls back for non-string types", () => {
    expect(resolveStableId(42, "ralph", [0])).toBe("ralph:0");
    expect(resolveStableId(true, "ralph", [1])).toBe("ralph:1");
  });

  test("explicit id with trimmed value is used", () => {
    expect(resolveStableId("  valid  ", "ralph", [0])).toBe("  valid  ");
  });
});
