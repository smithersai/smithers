import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MERGE_QUEUE_CONCURRENCY,
  WORKTREE_EMPTY_PATH_ERROR,
} from "../src/constants";

describe("constants", () => {
  test("DEFAULT_MERGE_QUEUE_CONCURRENCY is 1", () => {
    expect(DEFAULT_MERGE_QUEUE_CONCURRENCY).toBe(1);
  });

  test("WORKTREE_EMPTY_PATH_ERROR is a non-empty string", () => {
    expect(typeof WORKTREE_EMPTY_PATH_ERROR).toBe("string");
    expect(WORKTREE_EMPTY_PATH_ERROR.length).toBeGreaterThan(0);
    expect(WORKTREE_EMPTY_PATH_ERROR).toContain("path");
  });
});
