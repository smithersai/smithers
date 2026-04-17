import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireRewindLock,
  hasRewindLock,
  resetRewindLocksForTests,
} from "../src/rewindLock.js";

afterEach(() => {
  resetRewindLocksForTests();
});

describe("rewindLock", () => {
  test("single caller acquires/releases; second caller proceeds", () => {
    const first = acquireRewindLock("run-1");
    expect(first).not.toBeNull();
    expect(hasRewindLock("run-1")).toBe(true);

    expect(first?.release()).toBe(true);
    expect(hasRewindLock("run-1")).toBe(false);

    const second = acquireRewindLock("run-1");
    expect(second).not.toBeNull();
    expect(hasRewindLock("run-1")).toBe(true);
    expect(second?.release()).toBe(true);
  });

  test("two concurrent callers on same run: second gets Busy lock miss immediately", () => {
    const first = acquireRewindLock("run-busy");
    const second = acquireRewindLock("run-busy");

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    expect(first?.release()).toBe(true);
  });

  test("concurrent callers on different runIds both proceed", () => {
    const runA = acquireRewindLock("run-A");
    const runB = acquireRewindLock("run-B");

    expect(runA).not.toBeNull();
    expect(runB).not.toBeNull();

    expect(hasRewindLock("run-A")).toBe(true);
    expect(hasRewindLock("run-B")).toBe(true);

    expect(runA?.release()).toBe(true);
    expect(runB?.release()).toBe(true);
  });

  test("lock is released when handler throws", async () => {
    const runId = "run-throw";

    const runWithLock = async () => {
      const lock = acquireRewindLock(runId);
      if (!lock) {
        throw new Error("Busy");
      }
      try {
        throw new Error("boom");
      } finally {
        lock.release();
      }
    };

    await expect(runWithLock()).rejects.toThrow("boom");
    expect(hasRewindLock(runId)).toBe(false);
    expect(acquireRewindLock(runId)).not.toBeNull();
  });

  test("release is idempotent and never unlocks twice", () => {
    const lock = acquireRewindLock("run-idempotent");
    expect(lock).not.toBeNull();

    expect(lock?.release()).toBe(true);
    expect(lock?.release()).toBe(false);
    expect(hasRewindLock("run-idempotent")).toBe(false);
  });
});
