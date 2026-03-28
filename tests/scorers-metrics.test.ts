import { describe, expect, test } from "bun:test";
import {
  scorersStarted,
  scorersFinished,
  scorersFailed,
  scorerDuration,
} from "../src/scorers/metrics";

describe("scorer metrics", () => {
  test("scorersStarted is a counter", () => {
    expect(scorersStarted).toBeDefined();
    // Effect metrics have a pipe method
    expect(typeof scorersStarted.pipe).toBe("function");
  });

  test("scorersFinished is a counter", () => {
    expect(scorersFinished).toBeDefined();
    expect(typeof scorersFinished.pipe).toBe("function");
  });

  test("scorersFailed is a counter", () => {
    expect(scorersFailed).toBeDefined();
    expect(typeof scorersFailed.pipe).toBe("function");
  });

  test("scorerDuration is a histogram", () => {
    expect(scorerDuration).toBeDefined();
    expect(typeof scorerDuration.pipe).toBe("function");
  });

  test("all metrics are distinct objects", () => {
    const metrics = [scorersStarted, scorersFinished, scorersFailed, scorerDuration];
    const unique = new Set(metrics);
    expect(unique.size).toBe(4);
  });
});
