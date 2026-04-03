import { describe, expect, test } from "bun:test";
import { computeRetryDelayMs } from "../src/utils/retry";

describe("computeRetryDelayMs", () => {
  test("returns 0 without policy or delay", () => {
    expect(computeRetryDelayMs(undefined, 1)).toBe(0);
    expect(computeRetryDelayMs({ backoff: "fixed" }, 1)).toBe(0);
  });

  test("fixed backoff uses initialDelay", () => {
    expect(computeRetryDelayMs({ backoff: "fixed", initialDelayMs: 100 }, 1)).toBe(100);
    expect(computeRetryDelayMs({ backoff: "fixed", initialDelayMs: 100 }, 3)).toBe(100);
  });

  test("linear backoff scales by attempt", () => {
    expect(computeRetryDelayMs({ backoff: "linear", initialDelayMs: 50 }, 1)).toBe(50);
    expect(computeRetryDelayMs({ backoff: "linear", initialDelayMs: 50 }, 3)).toBe(150);
  });

  test("exponential backoff doubles per attempt", () => {
    expect(computeRetryDelayMs({ backoff: "exponential", initialDelayMs: 25 }, 1)).toBe(25);
    expect(computeRetryDelayMs({ backoff: "exponential", initialDelayMs: 25 }, 2)).toBe(50);
    expect(computeRetryDelayMs({ backoff: "exponential", initialDelayMs: 25 }, 3)).toBe(100);
  });
});
