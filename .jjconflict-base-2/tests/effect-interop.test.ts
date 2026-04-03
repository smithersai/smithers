import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { toError, fromPromise, fromSync, ignoreSyncError } from "../src/effect/interop";
import { SmithersError } from "../src/utils/errors";

const DOCS_URL = "https://smithers.sh/reference/errors";

describe("toError", () => {
  test("returns SmithersError unchanged when no label", () => {
    const original = new SmithersError("INTERNAL_ERROR", "boom");
    const result = toError(original);
    expect(result).toBe(original);
  });

  test("wraps plain Error into SmithersError", () => {
    const original = new Error("boom");
    const result = toError(original);
    expect(result).toBeInstanceOf(SmithersError);
    expect(result.message).toContain("boom");
  });

  test("wraps Error with label", () => {
    const original = new Error("boom");
    const result = toError(original, "context");
    expect(result.message).toContain("context: boom");
    expect(result.cause).toBe(original);
  });

  test("converts string to SmithersError", () => {
    const result = toError("string error");
    expect(result).toBeInstanceOf(SmithersError);
    expect(result.message).toContain("string error");
  });

  test("converts string with label", () => {
    const result = toError("oops", "label");
    expect(result.message).toContain("label: oops");
  });

  test("converts number to SmithersError", () => {
    const result = toError(42);
    expect(result.message).toContain("42");
  });

  test("converts null to SmithersError", () => {
    const result = toError(null);
    expect(result.message).toContain("null");
  });

  test("converts undefined to SmithersError", () => {
    const result = toError(undefined);
    expect(result.message).toContain("undefined");
  });

  test("includes docs URL in message", () => {
    const result = toError("some error");
    expect(result.message).toContain(DOCS_URL);
  });

  test("preserves SmithersError code when wrapping with label", () => {
    const original = new SmithersError("TASK_TIMEOUT", "timed out");
    const result = toError(original, "step-1");
    expect(result.code).toBe("TASK_TIMEOUT");
    expect(result.message).toContain("step-1");
  });
});

describe("fromPromise", () => {
  test("resolves successful promise", async () => {
    const effect = fromPromise("test", () => Promise.resolve(42));
    const result = await Effect.runPromise(effect);
    expect(result).toBe(42);
  });

  test("wraps rejected promise error with label", async () => {
    const effect = fromPromise("fetch", () => Promise.reject(new Error("timeout")));
    const exit = await Effect.runPromiseExit(effect);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause.toString();
      expect(error).toContain("fetch");
      expect(error).toContain("timeout");
    }
  });

  test("wraps non-error rejection with label", async () => {
    const effect = fromPromise("api", () => Promise.reject("string error"));
    const exit = await Effect.runPromiseExit(effect);
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("fromSync", () => {
  test("captures sync return value", async () => {
    const effect = fromSync("compute", () => 2 + 2);
    const result = await Effect.runPromise(effect);
    expect(result).toBe(4);
  });

  test("wraps thrown error with label", async () => {
    const effect = fromSync("parse", () => {
      throw new Error("bad input");
    });
    const exit = await Effect.runPromiseExit(effect);
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("ignoreSyncError", () => {
  test("runs function successfully", async () => {
    let called = false;
    const effect = ignoreSyncError("cleanup", () => { called = true; });
    await Effect.runPromise(effect);
    expect(called).toBe(true);
  });

  test("swallows thrown errors", async () => {
    const effect = ignoreSyncError("cleanup", () => {
      throw new Error("ignored");
    });
    // Should not throw
    await Effect.runPromise(effect);
  });
});
