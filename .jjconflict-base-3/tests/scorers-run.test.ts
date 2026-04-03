import { describe, expect, test } from "bun:test";
import { createScorer, runScorersBatch } from "../src/scorers";
import type { ScorerContext, ScorersMap } from "../src/scorers";

function makeCtx(overrides?: Partial<ScorerContext>): ScorerContext {
  return {
    runId: "run-1",
    nodeId: "node-1",
    iteration: 0,
    attempt: 1,
    input: "test input",
    output: "test output",
    ...overrides,
  };
}

describe("runScorersBatch", () => {
  test("returns empty object for empty scorers map", async () => {
    const result = await runScorersBatch({}, makeCtx(), null);
    expect(result).toEqual({});
  });

  test("executes all scorers and returns results", async () => {
    const scorers: ScorersMap = {
      a: {
        scorer: createScorer({
          id: "a",
          name: "A",
          description: "Test A",
          score: async () => ({ score: 0.8 }),
        }),
      },
      b: {
        scorer: createScorer({
          id: "b",
          name: "B",
          description: "Test B",
          score: async () => ({ score: 0.5, reason: "OK" }),
        }),
      },
    };
    const result = await runScorersBatch(scorers, makeCtx(), null);
    expect(result.a?.score).toBe(0.8);
    expect(result.b?.score).toBe(0.5);
    expect(result.b?.reason).toBe("OK");
  });

  test("returns null for failed scorers", async () => {
    const scorers: ScorersMap = {
      good: {
        scorer: createScorer({
          id: "good",
          name: "Good",
          description: "Good",
          score: async () => ({ score: 1 }),
        }),
      },
      bad: {
        scorer: createScorer({
          id: "bad",
          name: "Bad",
          description: "Bad",
          score: async () => {
            throw new Error("Scorer explosion");
          },
        }),
      },
    };
    const result = await runScorersBatch(scorers, makeCtx(), null);
    expect(result.good?.score).toBe(1);
    expect(result.bad).toBeNull();
  });

  test("respects sampling type none", async () => {
    const scorers: ScorersMap = {
      skipped: {
        scorer: createScorer({
          id: "skip",
          name: "Skip",
          description: "Skipped",
          score: async () => ({ score: 1 }),
        }),
        sampling: { type: "none" },
      },
    };
    const result = await runScorersBatch(scorers, makeCtx(), null);
    expect(result.skipped).toBeNull();
  });

  test("respects sampling type all", async () => {
    const scorers: ScorersMap = {
      always: {
        scorer: createScorer({
          id: "always",
          name: "Always",
          description: "Always runs",
          score: async () => ({ score: 0.9 }),
        }),
        sampling: { type: "all" },
      },
    };
    const result = await runScorersBatch(scorers, makeCtx(), null);
    expect(result.always?.score).toBe(0.9);
  });

  test("passes input and output to scorer function", async () => {
    let receivedInput: unknown;
    let receivedOutput: unknown;
    const scorers: ScorersMap = {
      check: {
        scorer: createScorer({
          id: "check",
          name: "Check",
          description: "Check",
          score: async ({ input, output }) => {
            receivedInput = input;
            receivedOutput = output;
            return { score: 1 };
          },
        }),
      },
    };
    await runScorersBatch(scorers, makeCtx({ input: "hello", output: "world" }), null);
    expect(receivedInput).toBe("hello");
    expect(receivedOutput).toBe("world");
  });

  test("handles null adapter gracefully", async () => {
    const scorers: ScorersMap = {
      test: {
        scorer: createScorer({
          id: "test",
          name: "Test",
          description: "Test",
          score: async () => ({ score: 0.5 }),
        }),
      },
    };
    // Should not throw even with null adapter
    const result = await runScorersBatch(scorers, makeCtx(), null);
    expect(result.test?.score).toBe(0.5);
  });
});
