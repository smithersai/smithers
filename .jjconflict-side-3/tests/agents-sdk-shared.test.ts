import { describe, expect, test } from "bun:test";
import {
  resolveSdkModel,
  streamResultToGenerateResult,
} from "../src/agents/sdk-shared";

// ---------------------------------------------------------------------------
// resolveSdkModel — model factory pattern
// ---------------------------------------------------------------------------

describe("resolveSdkModel", () => {
  test("returns factory result when given a string", () => {
    const mockModel = { id: "test-model" };
    const result = resolveSdkModel("my-model-id", (id) => ({
      ...mockModel,
      resolvedFrom: id,
    }));
    expect(result.resolvedFrom).toBe("my-model-id");
    expect(result.id).toBe("test-model");
  });

  test("returns the model as-is when not a string", () => {
    const prebuiltModel = { id: "prebuilt", custom: true };
    const result = resolveSdkModel(prebuiltModel, () => {
      throw new Error("should not be called");
    });
    expect(result).toBe(prebuiltModel);
    expect(result.custom).toBe(true);
  });

  test("handles empty string as string input", () => {
    const result = resolveSdkModel("", (id) => ({ created: true, id }));
    expect(result.created).toBe(true);
    expect(result.id).toBe("");
  });
});

// ---------------------------------------------------------------------------
// streamResultToGenerateResult — stream → generate conversion
// ---------------------------------------------------------------------------

describe("streamResultToGenerateResult", () => {
  const usage = {
    inputTokens: 10,
    inputTokenDetails: {
      noCacheTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens: 5,
    outputTokenDetails: {
      textTokens: 5,
      reasoningTokens: 0,
    },
    totalTokens: 15,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    raw: undefined,
  };

  function createMockStream(textParts: string[]) {
    let consumed = false;
    return {
      fullStream: (async function* () {
        for (const text of textParts) {
          yield { type: "text-delta" as const, text };
        }
      })(),
      consumeStream: async () => {
        consumed = true;
      },
      content: Promise.resolve([{ type: "text" as const, text: textParts.join("") }]),
      text: Promise.resolve(textParts.join("")),
      reasoning: Promise.resolve(undefined),
      reasoningText: Promise.resolve(undefined),
      files: Promise.resolve([]),
      sources: Promise.resolve([]),
      toolCalls: Promise.resolve([]),
      staticToolCalls: Promise.resolve([]),
      dynamicToolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
      staticToolResults: Promise.resolve([]),
      dynamicToolResults: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      rawFinishReason: Promise.resolve("stop"),
      usage: Promise.resolve(usage),
      totalUsage: Promise.resolve(usage),
      warnings: Promise.resolve([]),
      steps: Promise.resolve([]),
      request: Promise.resolve({}),
      response: Promise.resolve({}),
      providerMetadata: Promise.resolve({}),
      output: Promise.resolve(undefined),
      get _consumed() { return consumed; },
    };
  }

  test("converts stream to generate result with stdout callback", async () => {
    const textParts = ["Hello", " ", "World"];
    const stream = createMockStream(textParts);
    const chunks: string[] = [];

    const result = await streamResultToGenerateResult(
      stream as any,
      (text) => chunks.push(text),
    );

    expect(chunks).toEqual(["Hello", " ", "World"]);
    expect(result.text).toBe("Hello World");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual(usage);
  });

  test("consumes stream without callback", async () => {
    const stream = createMockStream(["data"]);

    const result = await streamResultToGenerateResult(stream as any);

    expect(result.text).toBe("data");
    expect(result.finishReason).toBe("stop");
    // The stream should have been consumed via consumeStream()
    expect(stream._consumed).toBe(true);
  });

  test("preserves all result properties", async () => {
    const stream = createMockStream(["test"]);
    const result = await streamResultToGenerateResult(stream as any);

    expect(result.content).toBeDefined();
    expect(result.toolCalls).toEqual([]);
    expect(result.toolResults).toEqual([]);
    expect(result.steps).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.output).toBeUndefined();
    expect(result.experimental_output).toBeUndefined();
  });
});
