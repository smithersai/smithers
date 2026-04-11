import { randomUUID } from "node:crypto";
import type { GenerateTextResult, StreamTextResult } from "ai";

function asyncIterableToStream<T>(
  iterable: AsyncIterable<T>,
): ReadableStream<T> & AsyncIterable<T> {
  const stream = new ReadableStream<T>({
    async start(controller) {
      try {
        for await (const item of iterable) {
          controller.enqueue(item);
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });
  (stream as any)[Symbol.asyncIterator] =
    iterable[Symbol.asyncIterator].bind(iterable);
  return stream as any;
}

export function buildStreamResult(
  result: GenerateTextResult<any, any>,
): StreamTextResult<any, any> {
  const text = result.text ?? "";
  const content = result.content ?? [];
  const steps = result.steps ?? [];
  const usage = result.usage ?? {
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
  const totalUsage = result.totalUsage ?? usage;
  const response = result.response ?? {
    id: randomUUID(),
    timestamp: new Date(),
    modelId: "unknown",
    messages: [],
  };
  const request = result.request ?? {};

  const textStream = asyncIterableToStream<string>(
    (async function* () {
      if (text) yield text;
    })(),
  );
  const fullStream = asyncIterableToStream<any>(
    (async function* () {
      const id = randomUUID();
      yield { type: "text-start", id };
      if (text) {
        yield { type: "text-delta", id, text };
      }
      yield { type: "text-end", id };
    })(),
  );

  return {
    content: Promise.resolve(content),
    text: Promise.resolve(text),
    reasoning: Promise.resolve(result.reasoning ?? []),
    reasoningText: Promise.resolve(result.reasoningText),
    files: Promise.resolve(result.files ?? []),
    sources: Promise.resolve(result.sources ?? []),
    toolCalls: Promise.resolve(result.toolCalls ?? []),
    staticToolCalls: Promise.resolve(result.staticToolCalls ?? []),
    dynamicToolCalls: Promise.resolve(result.dynamicToolCalls ?? []),
    staticToolResults: Promise.resolve(result.staticToolResults ?? []),
    dynamicToolResults: Promise.resolve(result.dynamicToolResults ?? []),
    toolResults: Promise.resolve(result.toolResults ?? []),
    finishReason: Promise.resolve(result.finishReason ?? "stop"),
    rawFinishReason: Promise.resolve(result.rawFinishReason),
    usage: Promise.resolve(usage),
    totalUsage: Promise.resolve(totalUsage),
    warnings: Promise.resolve(result.warnings),
    steps: Promise.resolve(steps),
    request: Promise.resolve(request),
    response: Promise.resolve(response),
    providerMetadata: Promise.resolve(result.providerMetadata),
    textStream: textStream as any,
    fullStream: fullStream as any,
  } as unknown as StreamTextResult<any, any>;
}
