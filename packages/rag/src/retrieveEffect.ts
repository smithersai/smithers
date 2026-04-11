import { Effect, Metric } from "effect";
import { fromPromise } from "@smithers/driver/interop";
import { embedQueryEffect } from "./embedder";
import { ragRetrieveCount } from "./ragRetrieveCount";
import { acquireVectorStore } from "./vector-store";
import type { RagPipelineConfig } from "./RagPipelineConfig";

export function retrieveEffect(config: RagPipelineConfig, query: string, topK?: number) {
  return Effect.scoped(Effect.gen(function* () {
    const vectorStore = yield* acquireVectorStore(config.vectorStore);
    const embedding = yield* embedQueryEffect(query, config.embeddingModel);
    const results = yield* fromPromise("rag pipeline query", () =>
      vectorStore.query(embedding, {
        topK: topK ?? config.topK ?? 10,
        namespace: config.namespace,
      }),
    );
    yield* Metric.increment(ragRetrieveCount);
    return results;
  })).pipe(
    Effect.annotateLogs({ operation: "ragRetrieve" }),
    Effect.withLogSpan("rag:retrieve"),
  );
}
