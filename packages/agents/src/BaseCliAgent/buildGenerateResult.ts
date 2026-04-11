import { randomUUID } from "node:crypto";
import type { GenerateTextResult } from "ai";

export function buildGenerateResult(
  text: string,
  output: unknown,
  modelId: string,
  usage?: any,
): GenerateTextResult<any, any> {
  const finalUsage = usage ?? {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: undefined,
  };
  return {
    content: [{ type: "text", text }],
    text,
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: [],
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: "stop",
    rawFinishReason: undefined,
    usage: finalUsage,
    totalUsage: finalUsage,
    warnings: undefined,
    request: {},
    response: {
      id: randomUUID(),
      timestamp: new Date(),
      modelId,
      messages: [],
    },
    providerMetadata: undefined,
    steps: [],
    experimental_output: output as any,
    output: output as any,
  } as GenerateTextResult<any, any>;
}
