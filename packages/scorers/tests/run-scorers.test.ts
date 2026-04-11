import { describe, expect, it, mock, beforeEach } from "bun:test";
import { createScorer } from "../src/create-scorer";
import { runScorersBatch } from "../src/run-scorers";
import type { ScorersMap, ScorerContext } from "../src/types";

// Mock DB adapter — only needs insertScorerResult for our tests
function createMockAdapter() {
  const rows: any[] = [];
  return {
    rows,
    insertScorerResult: mock((_row: any) => {
      rows.push(_row);
      // Return an Effect-like object that succeeds synchronously
      const { Effect } = require("effect");
      return Effect.succeed(undefined);
    }),
  } as any;
}

function makeContext(overrides?: Partial<ScorerContext>): ScorerContext {
  return {
    runId: "run-1",
    nodeId: "task-1",
    iteration: 0,
    attempt: 1,
    input: "test prompt",
    output: { result: "test output" },
    latencyMs: 1500,
    ...overrides,
  };
}

describe("runScorersBatch", () => {
  it("runs all scorers and returns results", async () => {
    const scorers: ScorersMap = {
      alpha: {
        scorer: createScorer({
          id: "alpha",
          name: "Alpha",
          description: "d",
          score: async () => ({ score: 0.8, reason: "Good" }),
        }),
      },
      beta: {
        scorer: createScorer({
          id: "beta",
          name: "Beta",
          description: "d",
          score: async () => ({ score: 0.6 }),
        }),
      },
    };

    const results = await runScorersBatch(scorers, makeContext(), null);

    expect(results.alpha).toBeDefined();
    expect(results.alpha?.score).toBe(0.8);
    expect(results.alpha?.reason).toBe("Good");
    expect(results.beta?.score).toBe(0.6);
  });

  it("returns empty object for empty scorers map", async () => {
    const results = await runScorersBatch({}, makeContext(), null);
    expect(Object.keys(results)).toHaveLength(0);
  });

  it("respects sampling: none", async () => {
    const scoreFn = mock(async () => ({ score: 1 }));
    const scorers: ScorersMap = {
      skipped: {
        scorer: createScorer({
          id: "skipped",
          name: "Skipped",
          description: "d",
          score: scoreFn,
        }),
        sampling: { type: "none" },
      },
    };

    const results = await runScorersBatch(scorers, makeContext(), null);
    expect(results.skipped).toBeNull();
    expect(scoreFn).not.toHaveBeenCalled();
  });

  it("respects sampling: all", async () => {
    const scoreFn = mock(async () => ({ score: 1 }));
    const scorers: ScorersMap = {
      always: {
        scorer: createScorer({
          id: "always",
          name: "Always",
          description: "d",
          score: scoreFn,
        }),
        sampling: { type: "all" },
      },
    };

    const results = await runScorersBatch(scorers, makeContext(), null);
    expect(results.always?.score).toBe(1);
    expect(scoreFn).toHaveBeenCalledTimes(1);
  });

  it("handles scorer errors gracefully", async () => {
    const scorers: ScorersMap = {
      failing: {
        scorer: createScorer({
          id: "failing",
          name: "Failing",
          description: "d",
          score: async () => {
            throw new Error("Scorer exploded");
          },
        }),
      },
      working: {
        scorer: createScorer({
          id: "working",
          name: "Working",
          description: "d",
          score: async () => ({ score: 0.9 }),
        }),
      },
    };

    const results = await runScorersBatch(scorers, makeContext(), null);
    // Failing scorer should return null, not crash the batch
    expect(results.failing).toBeNull();
    expect(results.working?.score).toBe(0.9);
  });

  it("persists results to adapter when provided", async () => {
    const adapter = createMockAdapter();
    const scorers: ScorersMap = {
      persisted: {
        scorer: createScorer({
          id: "persisted",
          name: "Persisted",
          description: "d",
          score: async () => ({ score: 0.75, reason: "Decent" }),
        }),
      },
    };

    await runScorersBatch(scorers, makeContext(), adapter);
    expect(adapter.insertScorerResult).toHaveBeenCalledTimes(1);

    const insertedRow = adapter.rows[0];
    expect(insertedRow).toBeDefined();
    expect(insertedRow.runId).toBe("run-1");
    expect(insertedRow.nodeId).toBe("task-1");
    expect(insertedRow.scorerId).toBe("persisted");
    expect(insertedRow.score).toBe(0.75);
    expect(insertedRow.reason).toBe("Decent");
    expect(insertedRow.source).toBe("batch");
  });

  it("passes correct scorer input fields", async () => {
    let receivedInput: any;
    const scorers: ScorersMap = {
      capture: {
        scorer: createScorer({
          id: "capture",
          name: "Capture",
          description: "d",
          score: async (input) => {
            receivedInput = input;
            return { score: 1 };
          },
        }),
      },
    };

    const ctx = makeContext({
      input: "my prompt",
      output: { data: "my output" },
      latencyMs: 2500,
    });

    await runScorersBatch(scorers, ctx, null);

    expect(receivedInput.input).toBe("my prompt");
    expect(receivedInput.output).toEqual({ data: "my output" });
    expect(receivedInput.latencyMs).toBe(2500);
  });
});
