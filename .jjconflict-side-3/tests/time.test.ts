import { describe, expect, test } from "bun:test";
import { nowMs } from "../src/utils/time";

describe("nowMs", () => {
  test("returns a number", () => {
    expect(typeof nowMs()).toBe("number");
  });

  test("returns current time in ms", () => {
    const before = Date.now();
    const result = nowMs();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  test("successive calls are non-decreasing", () => {
    const a = nowMs();
    const b = nowMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
