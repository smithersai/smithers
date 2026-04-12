import { randomUUID } from "node:crypto";
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */

/**
 * @param {string} text
 * @param {unknown} output
 * @param {string} modelId
 * @param {any} [usage]
 * @returns {GenerateTextResult<any, any>}
 */
export function buildGenerateResult(text, output, modelId, usage) {
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
        experimental_output: output,
        output: output,
    };
}
