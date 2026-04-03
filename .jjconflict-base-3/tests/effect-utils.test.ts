import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import {
  toError,
  fromPromise,
  fromSync,
  ignoreSyncError,
} from "../src/effect/interop";
import {
  runPromise,
  runFork,
  runSync,
} from "../src/effect/runtime";
import {
  logDebug,
  logInfo,
  logWarning,
  logError,
} from "../src/effect/logging";
import {
  ERROR_REFERENCE_URL,
  SmithersError,
} from "../src/utils/errors";

function expectSmithersMessage(err: unknown, summary: string) {
  expect(err).toBeInstanceOf(SmithersError);
  expect((err as Error).message).toBe(`${summary} See ${ERROR_REFERENCE_URL}`);
}

// ---------------------------------------------------------------------------
// interop.ts
// ---------------------------------------------------------------------------
describe("interop", () => {
  // ---- toError ------------------------------------------------------------
  describe("toError", () => {
    test("wraps a plain Error when no label is given", () => {
      const original = new Error("boom");
      const result = toError(original);
      expectSmithersMessage(result, "boom");
      expect(result.cause).toBe(original);
    });

    test("wraps an Error with a label prefix and preserves cause", () => {
      const original = new Error("boom");
      const result = toError(original, "myLabel");
      expectSmithersMessage(result, "myLabel: boom");
      expect(result.cause).toBe(original);
    });

    test("converts a string cause to an Error with label", () => {
      const result = toError("something broke", "op");
      expectSmithersMessage(result, "op: something broke");
    });

    test("converts a string cause to an Error without label", () => {
      const result = toError("raw string");
      expectSmithersMessage(result, "raw string");
    });

    test("converts null to an Error", () => {
      const result = toError(null);
      expectSmithersMessage(result, "null");
    });

    test("converts null to an Error with label", () => {
      const result = toError(null, "check");
      expectSmithersMessage(result, "check: null");
    });

    test("converts undefined to an Error", () => {
      const result = toError(undefined);
      expectSmithersMessage(result, "undefined");
    });

    test("converts undefined to an Error with label", () => {
      const result = toError(undefined, "init");
      expectSmithersMessage(result, "init: undefined");
    });

    test("converts a number cause to an Error", () => {
      const result = toError(42, "num");
      expectSmithersMessage(result, "num: 42");
    });
  });

  // ---- fromPromise --------------------------------------------------------
  describe("fromPromise", () => {
    test("succeeds with the resolved value", async () => {
      const effect = fromPromise("fetch", () => Promise.resolve(42));
      const result = await Effect.runPromise(effect);
      expect(result).toBe(42);
    });

    test("fails with a labeled Error when the promise rejects with an Error", async () => {
      const effect = fromPromise("fetch", () =>
        Promise.reject(new Error("network")),
      );
      const exit = await Effect.runPromiseExit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Cause.failureOption(exit.cause);
        expect(err._tag).toBe("Some");
        if (err._tag === "Some") {
          expectSmithersMessage(err.value, "fetch: network");
        }
      }
    });

    test("fails with a labeled Error when the promise rejects with a non-Error", async () => {
      const effect = fromPromise("fetch", () => Promise.reject("oops"));
      const exit = await Effect.runPromiseExit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Cause.failureOption(exit.cause);
        expect(err._tag).toBe("Some");
        if (err._tag === "Some") {
          expectSmithersMessage(err.value, "fetch: oops");
        }
      }
    });

    test("label appears in the error message", async () => {
      const effect = fromPromise("myOperation", () =>
        Promise.reject(new Error("fail")),
      );
      const exit = await Effect.runPromiseExit(effect);
      if (Exit.isFailure(exit)) {
        const err = Cause.failureOption(exit.cause);
        if (err._tag === "Some") {
          expect(err.value.message).toContain("myOperation");
        }
      }
    });
  });

  // ---- fromSync -----------------------------------------------------------
  describe("fromSync", () => {
    test("succeeds with the returned value", async () => {
      const effect = fromSync("parse", () => JSON.parse('{"a":1}'));
      const result = await Effect.runPromise(effect);
      expect(result).toEqual({ a: 1 });
    });

    test("fails with a labeled Error when the function throws an Error", async () => {
      const effect = fromSync("parse", () => {
        throw new Error("bad json");
      });
      const exit = await Effect.runPromiseExit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Cause.failureOption(exit.cause);
        expect(err._tag).toBe("Some");
        if (err._tag === "Some") {
          expectSmithersMessage(err.value, "parse: bad json");
        }
      }
    });

    test("fails with a labeled Error when the function throws a non-Error", async () => {
      const effect = fromSync("compute", () => {
        throw "string error";
      });
      const exit = await Effect.runPromiseExit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Cause.failureOption(exit.cause);
        expect(err._tag).toBe("Some");
        if (err._tag === "Some") {
          expectSmithersMessage(err.value, "compute: string error");
        }
      }
    });

    test("label appears in the error message", async () => {
      const effect = fromSync("mySync", () => {
        throw new Error("x");
      });
      const exit = await Effect.runPromiseExit(effect);
      if (Exit.isFailure(exit)) {
        const err = Cause.failureOption(exit.cause);
        if (err._tag === "Some") {
          expect(err.value.message).toContain("mySync");
        }
      }
    });
  });

  // ---- ignoreSyncError ----------------------------------------------------
  describe("ignoreSyncError", () => {
    test("runs the function that does not throw", async () => {
      let called = false;
      const effect = ignoreSyncError("cleanup", () => {
        called = true;
      });
      await Effect.runPromise(effect);
      expect(called).toBe(true);
    });

    test("swallows any thrown error", async () => {
      const effect = ignoreSyncError("cleanup", () => {
        throw new Error("ignored");
      });
      // Should not throw; the error is silently swallowed
      const result = await Effect.runPromise(effect);
      expect(result).toBeUndefined();
    });

    test("swallows a non-Error throw", async () => {
      const effect = ignoreSyncError("cleanup", () => {
        throw "just a string";
      });
      const result = await Effect.runPromise(effect);
      expect(result).toBeUndefined();
    });
  });

});

// ---------------------------------------------------------------------------
// runtime.ts
// ---------------------------------------------------------------------------
describe("runtime", () => {
  describe("runPromise", () => {
    test("returns the value of a successful effect", async () => {
      const result = await runPromise(Effect.succeed(42));
      expect(result).toBe(42);
    });

    test("throws the failure error for a failed effect", async () => {
      const effect = Effect.fail(new Error("expected failure"));
      try {
        await runPromise(effect);
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expectSmithersMessage(err, "expected failure");
      }
    });

    test("throws for a defect (die) in the effect", async () => {
      const effect = Effect.die(new Error("defect!"));
      try {
        await runPromise(effect);
        expect(true).toBe(false);
      } catch (err) {
        expectSmithersMessage(err, "defect!");
      }
    });

    test("throws a non-Error failure after normalizing it", async () => {
      const effect = Effect.fail("a string failure");
      try {
        await runPromise(effect);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    });
  });

  describe("runSync", () => {
    test("returns the value of a successful effect synchronously", () => {
      const result = runSync(Effect.succeed("hello"));
      expect(result).toBe("hello");
    });
  });

  describe("runFork", () => {
    test("forks an effect without throwing", () => {
      const fiber = runFork(Effect.succeed(1));
      expect(fiber).toBeDefined();
    });

    test("forks an effect that performs a side-effect", () => {
      // Just verify it does not throw; the side-effect runs asynchronously
      expect(() => runFork(Effect.log("fork test"))).not.toThrow();
    });
  });

});

// ---------------------------------------------------------------------------
// logging.ts
// ---------------------------------------------------------------------------
describe("logging", () => {
  test("logDebug does not throw", () => {
    expect(() => logDebug("debug message")).not.toThrow();
  });

  test("logInfo does not throw", () => {
    expect(() => logInfo("info message")).not.toThrow();
  });

  test("logWarning does not throw", () => {
    expect(() => logWarning("warning message")).not.toThrow();
  });

  test("logError does not throw", () => {
    expect(() => logError("error message")).not.toThrow();
  });

  test("logDebug with annotations does not throw", () => {
    expect(() =>
      logDebug("debug with annotations", { key: "value", count: 1 }),
    ).not.toThrow();
  });

  test("logInfo with annotations does not throw", () => {
    expect(() =>
      logInfo("info with annotations", { module: "test" }),
    ).not.toThrow();
  });

  test("logWarning with annotations does not throw", () => {
    expect(() =>
      logWarning("warning with annotations", { severity: "high" }),
    ).not.toThrow();
  });

  test("logError with annotations does not throw", () => {
    expect(() =>
      logError("error with annotations", { code: 500 }),
    ).not.toThrow();
  });

  test("logDebug with annotations and span does not throw", () => {
    expect(() =>
      logDebug("debug with span", { key: "value" }, "mySpan"),
    ).not.toThrow();
  });

  test("logInfo with annotations and span does not throw", () => {
    expect(() =>
      logInfo("info with span", { key: "value" }, "infoSpan"),
    ).not.toThrow();
  });

  test("logWarning with annotations and span does not throw", () => {
    expect(() =>
      logWarning("warning with span", undefined, "warnSpan"),
    ).not.toThrow();
  });

  test("logError with annotations and span does not throw", () => {
    expect(() =>
      logError("error with span", { err: "details" }, "errSpan"),
    ).not.toThrow();
  });

  test("logInfo with span but no annotations does not throw", () => {
    expect(() => logInfo("span only", undefined, "spanName")).not.toThrow();
  });
});
