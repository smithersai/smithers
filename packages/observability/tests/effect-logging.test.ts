import { describe, expect, test } from "bun:test";
import { logDebug, logInfo, logWarning, logError } from "@smithers/observability/logging";

describe("effect/logging", () => {
  // These functions fire-and-forget via runFork, so we just verify they don't throw.
  test("logDebug does not throw", () => {
    expect(() => logDebug("test debug")).not.toThrow();
  });

  test("logDebug with annotations does not throw", () => {
    expect(() => logDebug("test debug", { key: "value" })).not.toThrow();
  });

  test("logDebug with span does not throw", () => {
    expect(() => logDebug("test debug", undefined, "test-span")).not.toThrow();
  });

  test("logDebug with annotations and span does not throw", () => {
    expect(() => logDebug("debug", { runId: "r1" }, "span")).not.toThrow();
  });

  test("logInfo does not throw", () => {
    expect(() => logInfo("test info")).not.toThrow();
  });

  test("logInfo with annotations does not throw", () => {
    expect(() => logInfo("test info", { runId: "r1" })).not.toThrow();
  });

  test("logWarning does not throw", () => {
    expect(() => logWarning("test warning")).not.toThrow();
  });

  test("logWarning with annotations does not throw", () => {
    expect(() => logWarning("test warning", { reason: "retry" })).not.toThrow();
  });

  test("logError does not throw", () => {
    expect(() => logError("test error")).not.toThrow();
  });

  test("logError with annotations and span does not throw", () => {
    expect(() => logError("test error", { code: "ERR" }, "error-span")).not.toThrow();
  });
});
