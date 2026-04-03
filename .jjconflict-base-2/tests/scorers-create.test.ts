import { describe, expect, test } from "bun:test";
import { createScorer, llmJudge } from "../src/scorers";

describe("createScorer", () => {
  test("creates scorer with correct shape", () => {
    const scorer = createScorer({
      id: "test-scorer",
      name: "Test Scorer",
      description: "A test scorer",
      score: async () => ({ score: 0.5 }),
    });
    expect(scorer.id).toBe("test-scorer");
    expect(scorer.name).toBe("Test Scorer");
    expect(scorer.description).toBe("A test scorer");
    expect(typeof scorer.score).toBe("function");
  });

  test("score function is callable and async", async () => {
    const scorer = createScorer({
      id: "test",
      name: "Test",
      description: "Test",
      score: async ({ output }) => ({
        score: String(output).length > 0 ? 1 : 0,
      }),
    });
    const result = await scorer.score({ input: "", output: "hello" });
    expect(result.score).toBe(1);
  });
});

describe("llmJudge", () => {
  function mockJudge(response: any) {
    return {
      generate: async () => response,
    } as any;
  }

  test("parses valid JSON response with score", async () => {
    const judge = mockJudge({ text: '{"score": 0.8, "reason": "Good"}' });
    const scorer = llmJudge({
      id: "test",
      name: "Test",
      description: "Test",
      judge,
      instructions: "Evaluate",
      promptTemplate: ({ output }) => `Rate: ${output}`,
    });
    const result = await scorer.score({ input: "", output: "hello" });
    expect(result.score).toBe(0.8);
    expect(result.reason).toBe("Good");
  });

  test("handles string response directly", async () => {
    const judge = mockJudge('{"score": 0.7, "reason": "OK"}');
    const scorer = llmJudge({
      id: "test",
      name: "Test",
      description: "Test",
      judge,
      instructions: "Evaluate",
      promptTemplate: () => "Rate this",
    });
    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(0.7);
  });

  test("clamps score above 1 to 1", async () => {
    const judge = mockJudge({ text: '{"score": 1.5}' });
    const scorer = llmJudge({
      id: "test",
      name: "Test",
      description: "Test",
      judge,
      instructions: "",
      promptTemplate: () => "",
    });
    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(1);
  });

  test("clamps score below 0 to 0", async () => {
    const judge = mockJudge({ text: '{"score": -0.5}' });
    const scorer = llmJudge({
      id: "test",
      name: "Test",
      description: "Test",
      judge,
      instructions: "",
      promptTemplate: () => "",
    });
    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(0);
  });

  test("returns 0 for NaN score", async () => {
    const judge = mockJudge({ text: '{"score": "not a number"}' });
    const scorer = llmJudge({
      id: "test",
      name: "Test",
      description: "Test",
      judge,
      instructions: "",
      promptTemplate: () => "",
    });
    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(0);
  });

  test("returns 0 when JSON parsing fails", async () => {
    const judge = mockJudge({ text: "no json here" });
    const scorer = llmJudge({
      id: "test",
      name: "Test",
      description: "Test",
      judge,
      instructions: "",
      promptTemplate: () => "",
    });
    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(0);
    expect(result.reason).toContain("Failed to parse");
  });

  test("extracts JSON from surrounding text", async () => {
    const judge = mockJudge({
      text: 'Here is my evaluation:\n\n{"score": 0.9, "reason": "Great work"}\n\nThank you.',
    });
    const scorer = llmJudge({
      id: "test",
      name: "Test",
      description: "Test",
      judge,
      instructions: "",
      promptTemplate: () => "",
    });
    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(0.9);
    expect(result.reason).toBe("Great work");
  });

  test("includes raw response in meta", async () => {
    const judge = mockJudge({ text: '{"score": 0.5}' });
    const scorer = llmJudge({
      id: "test",
      name: "Test",
      description: "Test",
      judge,
      instructions: "",
      promptTemplate: () => "",
    });
    const result = await scorer.score({ input: "", output: "" });
    expect(result.meta?.raw).toBe('{"score": 0.5}');
  });

  test("passes instructions and prompt to judge", async () => {
    let receivedPrompt = "";
    const judge = {
      generate: async ({ prompt }: { prompt: string }) => {
        receivedPrompt = prompt;
        return { text: '{"score": 1}' };
      },
    } as any;
    const scorer = llmJudge({
      id: "test",
      name: "Test",
      description: "Test",
      judge,
      instructions: "Be strict",
      promptTemplate: ({ output }) => `Evaluate: ${String(output)}`,
    });
    await scorer.score({ input: "", output: "test output" });
    expect(receivedPrompt).toContain("Be strict");
    expect(receivedPrompt).toContain("Evaluate: test output");
  });

  test("falls back to JSON.stringify for non-string non-text response", async () => {
    const judge = mockJudge({ score: 0.6, reason: "Direct object" });
    const scorer = llmJudge({
      id: "test",
      name: "Test",
      description: "Test",
      judge,
      instructions: "",
      promptTemplate: () => "",
    });
    const result = await scorer.score({ input: "", output: "" });
    expect(result.score).toBe(0.6);
  });
});
