import { describe, expect, test } from "bun:test";
import { computeRetryDelayMs } from "../src/utils/retry";

describe("computeRetryDelayMs", () => {
  test("returns 0 for undefined policy", () => {
    expect(computeRetryDelayMs(undefined, 1)).toBe(0);
  });

  test("returns 0 when initialDelayMs is 0", () => {
    expect(computeRetryDelayMs({ initialDelayMs: 0 }, 1)).toBe(0);
  });

  test("returns 0 when initialDelayMs is negative", () => {
    expect(computeRetryDelayMs({ initialDelayMs: -100 }, 1)).toBe(0);
  });

  test("returns 0 when initialDelayMs is not a number", () => {
    expect(computeRetryDelayMs({ initialDelayMs: undefined }, 1)).toBe(0);
  });

  test("fixed backoff returns same delay for all attempts", () => {
    const policy = { backoff: "fixed" as const, initialDelayMs: 1000 };
    expect(computeRetryDelayMs(policy, 1)).toBe(1000);
    expect(computeRetryDelayMs(policy, 2)).toBe(1000);
    expect(computeRetryDelayMs(policy, 5)).toBe(1000);
  });

  test("defaults to fixed backoff when not specified", () => {
    const policy = { initialDelayMs: 500 };
    expect(computeRetryDelayMs(policy, 1)).toBe(500);
    expect(computeRetryDelayMs(policy, 3)).toBe(500);
  });

  test("linear backoff multiplies by attempt number", () => {
    const policy = { backoff: "linear" as const, initialDelayMs: 1000 };
    expect(computeRetryDelayMs(policy, 1)).toBe(1000);
    expect(computeRetryDelayMs(policy, 2)).toBe(2000);
    expect(computeRetryDelayMs(policy, 3)).toBe(3000);
  });

  test("exponential backoff doubles each attempt", () => {
    const policy = { backoff: "exponential" as const, initialDelayMs: 1000 };
    expect(computeRetryDelayMs(policy, 1)).toBe(1000);  // 2^0 = 1
    expect(computeRetryDelayMs(policy, 2)).toBe(2000);  // 2^1 = 2
    expect(computeRetryDelayMs(policy, 3)).toBe(4000);  // 2^2 = 4
    expect(computeRetryDelayMs(policy, 4)).toBe(8000);  // 2^3 = 8
  });

  test("rounds to nearest integer", () => {
    const policy = { backoff: "fixed" as const, initialDelayMs: 1500 };
    const result = computeRetryDelayMs(policy, 1);
    expect(result).toBe(1500);
    expect(Number.isInteger(result)).toBe(true);
  });

  test("floors fractional initialDelayMs", () => {
    const policy = { backoff: "fixed" as const, initialDelayMs: 999.7 };
    // base = Math.max(0, Math.floor(999.7)) = 999
    // multiplier = 1 (fixed), result = Math.max(0, Math.round(999 * 1)) = 999
    expect(computeRetryDelayMs(policy, 1)).toBe(999);
  });

  test("handles attempt < 1 by treating as 1", () => {
    const policy = { backoff: "linear" as const, initialDelayMs: 100 };
    expect(computeRetryDelayMs(policy, 0)).toBe(100); // safeAttempt = max(1, 0) = 1
    expect(computeRetryDelayMs(policy, -1)).toBe(100);
  });
});
