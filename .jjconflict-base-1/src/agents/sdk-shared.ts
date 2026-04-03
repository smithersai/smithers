import type {
  GenerateTextResult,
  StreamTextResult,
  ToolLoopAgentSettings,
  ToolSet,
} from "ai";

export type SdkAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  MODEL = any,
> = Omit<ToolLoopAgentSettings<CALL_OPTIONS, TOOLS>, "model"> & {
  /**
   * Either a provider model id string or a preconstructed AI SDK language model.
   * Passing a model instance is mainly useful for tests and advanced provider setup.
   */
  model: string | MODEL;
};

export function resolveSdkModel<MODEL>(
  value: string | MODEL,
  create: (modelId: string) => MODEL,
): MODEL {
  return typeof value === "string" ? create(value) : value;
}

export async function streamResultToGenerateResult<
  TOOLS extends ToolSet = {},
  OUTPUT = any,
>(
  stream: StreamTextResult<TOOLS, any>,
  onStdout?: (text: string) => void,
): Promise<GenerateTextResult<TOOLS, any>> {
  if (onStdout) {
    for await (const part of stream.fullStream) {
      if (part.type === "text-delta" && part.text) {
        onStdout(part.text);
      }
    }
  } else {
    await stream.consumeStream();
  }

  const [
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
    steps,
    request,
    response,
    providerMetadata,
    output,
  ] = await Promise.all([
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
  } as GenerateTextResult<TOOLS, any>;
}
