
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/** @typedef {import("ai").StreamTextResult} StreamTextResult */
/**
 * @template TOOLS, OUTPUT
 * @param {StreamTextResult<TOOLS, any>} stream
 * @param {(text: string) => void} [onStdout]
 * @returns {Promise<GenerateTextResult<TOOLS, any>>}
 */
export async function streamResultToGenerateResult(stream, onStdout) {
    if (onStdout) {
        for await (const part of stream.fullStream) {
            if (part.type === "text-delta" && part.text) {
                onStdout(part.text);
            }
        }
    }
    else {
        await stream.consumeStream();
    }
    const [content, text, reasoning, reasoningText, files, sources, toolCalls, staticToolCalls, dynamicToolCalls, toolResults, staticToolResults, dynamicToolResults, finishReason, rawFinishReason, usage, totalUsage, warnings, steps, request, response, providerMetadata, output,] = await Promise.all([
        stream.content,
        stream.text,
        stream.reasoning,
        stream.reasoningText,
        stream.files,
        stream.sources,
        stream.toolCalls,
        stream.staticToolCalls,
        stream.dynamicToolCalls,
        stream.toolResults,
        stream.staticToolResults,
        stream.dynamicToolResults,
        stream.finishReason,
        stream.rawFinishReason,
        stream.usage,
        stream.totalUsage,
        stream.warnings,
        stream.steps,
        stream.request,
        stream.response,
        stream.providerMetadata,
        stream.output,
    ]);
    return {
        content,
        text,
        reasoning,
        reasoningText,
        files,
        sources,
        toolCalls,
        staticToolCalls,
        dynamicToolCalls,
        toolResults,
        staticToolResults,
        dynamicToolResults,
        finishReason,
        rawFinishReason,
        usage,
        totalUsage,
        warnings,
        request,
        response,
        providerMetadata,
        steps,
        experimental_output: output,
        output,
    };
}
