import { describe, expect, it, mock } from "bun:test";
import { createScorer, llmJudge } from "../../src/scorers/create-scorer";
import type { Scorer, ScorerInput } from "../../src/scorers/types";

describe("createScorer", () => {
  it("creates a scorer from a config object", () => {
    const scorer = createScorer({
      id: "test-scorer",
      name: "Test Scorer",
      description: "A test scorer",
      score: async ({ output }) => ({
        score: String(output).length > 10 ? 1 : 0,
        reason: `Length: ${String(output).length}`,
      }),
    });

    expect(scorer.id).toBe("test-scorer");
    expect(scorer.name).toBe("Test Scorer");
    expect(scorer.description).toBe("A test scorer");
    expect(typeof scorer.score).toBe("function");
  });

  it("scorer function receives and processes input correctly", async () => {
    const scorer = createScorer({
      id: "length",
      name: "Length",
      description: "Length check",
      score: async ({ output, input }) => ({
        score: String(output).length > 5 ? 1 : 0,
        reason: `Input: ${String(input)}, Output length: ${String(output).length}`,
      }),
    });

    const result = await scorer.score({
      input: "hello",
      output: "this is a long output",
    });
    expect(result.score).toBe(1);
    expect(result.reason).toContain("Output length: 21");
  });

  it("scorer function can return minimal result", async () => {
    const scorer = createScorer({
      id: "min",
      name: "Min",
      description: "Minimal",
      score: async () => ({ score: 0.5 }),
    });

    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(0.5);
    expect(result.reason).toBeUndefined();
  });

  it("scorer function can use latencyMs", async () => {
    const scorer = createScorer({
      id: "latency-user",
      name: "Latency User",
      description: "Uses latency",
      score: async ({ latencyMs }) => ({
        score: latencyMs != null && latencyMs < 1000 ? 1 : 0,
      }),
    });

    const fast = await scorer.score({ input: "", output: "", latencyMs: 500 });
    expect(fast.score).toBe(1);

    const slow = await scorer.score({ input: "", output: "", latencyMs: 2000 });
    expect(slow.score).toBe(0);
  });
});

describe("llmJudge", () => {
  it("creates a scorer that calls the judge agent", async () => {
    const mockAgent = {
      generate: mock(async () => ({
        text: '{ "score": 0.85, "reason": "Well-formed response" }',
      })),
    };

    const scorer = llmJudge({
      id: "quality",
      name: "Quality",
      description: "Quality check",
      judge: mockAgent,
      instructions: "Evaluate quality.",
      promptTemplate: ({ output }) =>
        `Rate this: ${String(output)}`,
    });

    expect(scorer.id).toBe("quality");

    const result = await scorer.score({
      input: "prompt",
      output: "a good response",
    });

    expect(result.score).toBe(0.85);
    expect(result.reason).toBe("Well-formed response");
    expect(mockAgent.generate).toHaveBeenCalledTimes(1);
  });

  it("handles plain string response from judge", async () => {
    const mockAgent = {
      generate: mock(async () => '{ "score": 0.7, "reason": "OK" }'),
    };

    const scorer = llmJudge({
      id: "text-judge",
      name: "Text Judge",
      description: "d",
      judge: mockAgent,
      instructions: "Judge.",
      promptTemplate: ({ output }) => `Eval: ${String(output)}`,
    });

    const result = await scorer.score({ input: "", output: "test" });
    expect(result.score).toBe(0.7);
    expect(result.reason).toBe("OK");
  });

  it("handles unparseable response gracefully", async () => {
    const mockAgent = {
      generate: mock(async () => ({
        text: "I cannot evaluate this properly.",
      })),
    };

    const scorer = llmJudge({
      id: "bad-judge",
      name: "Bad Judge",
      description: "d",
      judge: mockAgent,
      instructions: "Judge.",
      promptTemplate: () => "eval",
    });

    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(0);
    expect(result.reason).toBe("Failed to parse judge response as JSON");
    expect(result.meta?.raw).toBeDefined();
  });

  it("clamps scores to 0-1 range", async () => {
    const mockAgent = {
      generate: mock(async () => ({
        text: '{ "score": 1.5, "reason": "Over max" }',
      })),
    };

    const scorer = llmJudge({
      id: "clamp",
      name: "Clamp",
      description: "d",
      judge: mockAgent,
      instructions: "Judge.",
      promptTemplate: () => "eval",
    });

    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(1);
  });

  it("handles negative scores by clamping to 0", async () => {
    const mockAgent = {
      generate: mock(async () => ({
        text: '{ "score": -0.5, "reason": "Negative" }',
      })),
    };

    const scorer = llmJudge({
      id: "clamp-neg",
      name: "Clamp Neg",
      description: "d",
      judge: mockAgent,
      instructions: "Judge.",
      promptTemplate: () => "eval",
    });

    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(0);
  });

  it("passes instructions and prompt template correctly", async () => {
    let capturedPrompt = "";
    const mockAgent = {
      generate: mock(async (args: any) => {
        capturedPrompt = args.prompt;
        return { text: '{ "score": 1 }' };
      }),
    };

    const scorer = llmJudge({
      id: "capture",
      name: "Capture",
      description: "d",
      judge: mockAgent,
      instructions: "SYSTEM_INSTRUCTIONS",
      promptTemplate: ({ input, output }) =>
        `INPUT=${String(input)} OUTPUT=${String(output)}`,
    });

    await scorer.score({ input: "myInput", output: "myOutput" });

    expect(capturedPrompt).toContain("SYSTEM_INSTRUCTIONS");
    expect(capturedPrompt).toContain("INPUT=myInput");
    expect(capturedPrompt).toContain("OUTPUT=myOutput");
  });
});
