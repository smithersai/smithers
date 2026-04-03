import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { toError, fromPromise, fromSync, ignoreSyncError } from "../src/effect/interop";
import { runPromise } from "../src/effect/runtime";
import { SmithersError, isSmithersError } from "../src/utils/errors";

describe("toError", () => {
  test("wraps plain Error into SmithersError", () => {
    const result = toError(new Error("test"), "test-context");
    expect(isSmithersError(result)).toBe(true);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.summary).toContain("test");
  });

  test("wraps string error", () => {
    const result = toError("string error", "ctx");
    expect(isSmithersError(result)).toBe(true);
    expect(result.summary).toContain("string error");
  });

  test("wraps null/undefined error", () => {
    const result = toError(null, "ctx");
    expect(isSmithersError(result)).toBe(true);
  });

  test("preserves existing SmithersError code", () => {
    const original = new SmithersError("INVALID_INPUT", "bad input");
    const result = toError(original, "ctx");
    expect(result.code).toBe("INVALID_INPUT");
  });

  test("stores label as operation in details", () => {
    const result = toError(new Error("test"), "my-context");
    expect(result.details?.operation).toBe("my-context");
  });

  test("uses custom code from options", () => {
    const result = toError(new Error("test"), "ctx", { code: "TASK_TIMEOUT" });
    expect(result.code).toBe("TASK_TIMEOUT");
  });

  test("merges custom details from options", () => {
    const result = toError(new Error("test"), "ctx", { details: { foo: "bar" } });
    expect(result.details?.foo).toBe("bar");
  });
});

describe("fromPromise", () => {
  test("resolves successful promise", async () => {
    const effect = fromPromise("test", () => Promise.resolve(42));
    const result = await runPromise(effect);
    expect(result).toBe(42);
  });

  test("maps rejected promise to SmithersError", async () => {
    const effect = fromPromise("test", () => Promise.reject(new Error("fail")));
    try {
      await runPromise(effect);
      expect.unreachable("should throw");
    } catch (err: any) {
      expect(isSmithersError(err)).toBe(true);
    }
  });
});

describe("fromSync", () => {
  test("wraps successful sync operation", async () => {
    const effect = fromSync("test", () => "hello");
    const result = await runPromise(effect);
    expect(result).toBe("hello");
  });

  test("maps thrown error to SmithersError", async () => {
    const effect = fromSync("test", () => {
      throw new Error("sync fail");
    });
    try {
      await runPromise(effect);
      expect.unreachable("should throw");
    } catch (err: any) {
      expect(isSmithersError(err)).toBe(true);
    }
  });
});

describe("ignoreSyncError", () => {
  test("does not throw on success", async () => {
    const effect = ignoreSyncError("test", () => {});
    await expect(runPromise(effect)).resolves.toBeUndefined();
  });

  test("swallows errors silently", async () => {
    const effect = ignoreSyncError("test", () => {
      throw new Error("ignored");
    });
    await expect(runPromise(effect)).resolves.toBeUndefined();
  });
});
