import { describe, expect, it } from "bun:test";
import type {
  ScoreResult,
  ScorerInput,
  ScorerFn,
  Scorer,
  SamplingConfig,
  ScorerBinding,
  ScorersMap,
  ScoreRow,
  AggregateScore,
  ScorerContext,
} from "../../src/scorers/types";

describe("scorers/types", () => {
  it("ScoreResult accepts valid shapes", () => {
    const minimal: ScoreResult = { score: 0.5 };
    expect(minimal.score).toBe(0.5);
    expect(minimal.reason).toBeUndefined();

    const full: ScoreResult = {
      score: 1,
      reason: "Perfect",
      meta: { model: "gpt-4" },
    };
    expect(full.score).toBe(1);
    expect(full.reason).toBe("Perfect");
    expect(full.meta?.model).toBe("gpt-4");
  });

  it("ScorerInput accepts minimal and full shapes", () => {
    const minimal: ScorerInput = { input: "hello", output: "world" };
    expect(minimal.input).toBe("hello");
    expect(minimal.groundTruth).toBeUndefined();

    const full: ScorerInput = {
      input: "prompt",
      output: { text: "response" },
      groundTruth: "expected",
      context: ["doc1"],
      latencyMs: 1500,
    };
    expect(full.latencyMs).toBe(1500);
  });

  it("ScorerFn is an async function returning ScoreResult", async () => {
    const fn: ScorerFn = async (input) => ({
      score: 0.8,
      reason: "Good",
    });
    const result = await fn({ input: "test", output: "out" });
    expect(result.score).toBe(0.8);
  });

  it("Scorer has required fields", () => {
    const scorer: Scorer = {
      id: "test",
      name: "Test Scorer",
      description: "A test",
      score: async () => ({ score: 1 }),
    };
    expect(scorer.id).toBe("test");
    expect(scorer.name).toBe("Test Scorer");
  });

  it("SamplingConfig variants", () => {
    const all: SamplingConfig = { type: "all" };
    const ratio: SamplingConfig = { type: "ratio", rate: 0.5 };
    const none: SamplingConfig = { type: "none" };
    expect(all.type).toBe("all");
    expect(ratio.type).toBe("ratio");
    if (ratio.type === "ratio") expect(ratio.rate).toBe(0.5);
    expect(none.type).toBe("none");
  });

  it("ScorerBinding wraps scorer with optional sampling", () => {
    const scorer: Scorer = {
      id: "s",
      name: "S",
      description: "d",
      score: async () => ({ score: 0 }),
    };
    const binding: ScorerBinding = { scorer };
    expect(binding.sampling).toBeUndefined();

    const sampled: ScorerBinding = {
      scorer,
      sampling: { type: "ratio", rate: 0.1 },
    };
    expect(sampled.sampling?.type).toBe("ratio");
  });

  it("ScorersMap is a record of string to ScorerBinding", () => {
    const scorer: Scorer = {
      id: "s",
      name: "S",
      description: "d",
      score: async () => ({ score: 0 }),
    };
    const map: ScorersMap = {
      first: { scorer },
      second: { scorer, sampling: { type: "none" } },
    };
    expect(Object.keys(map)).toEqual(["first", "second"]);
  });

  it("ScoreRow has all required fields", () => {
    const row: ScoreRow = {
      id: "uuid",
      runId: "run-1",
      nodeId: "task-1",
      iteration: 0,
      attempt: 1,
      scorerId: "s-1",
      scorerName: "Scorer 1",
      source: "live",
      score: 0.95,
      reason: "Good",
      metaJson: null,
      inputJson: null,
      outputJson: null,
      latencyMs: 1000,
      scoredAtMs: Date.now(),
      durationMs: 50,
    };
    expect(row.source).toBe("live");
  });

  it("AggregateScore has statistics fields", () => {
    const agg: AggregateScore = {
      scorerId: "s-1",
      scorerName: "Test",
      count: 10,
      mean: 0.85,
      min: 0.5,
      max: 1.0,
      p50: 0.9,
      stddev: 0.1,
    };
    expect(agg.count).toBe(10);
    expect(agg.mean).toBe(0.85);
  });

  it("ScorerContext has execution context fields", () => {
    const ctx: ScorerContext = {
      runId: "run-1",
      nodeId: "task-1",
      iteration: 0,
      attempt: 1,
      input: "prompt",
      output: { result: "data" },
      latencyMs: 2000,
    };
    expect(ctx.runId).toBe("run-1");
  });
});
