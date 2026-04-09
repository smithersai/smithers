import { Effect, Metric } from "effect";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { chunk } from "./chunker";
import { loadDocument } from "./document";
import { embedChunksEffect, embedQueryEffect } from "./embedder";
import { ragIngestCount, ragRetrieveCount } from "./metrics";
import { acquireVectorStore } from "./vector-store";
import type {
  Document,
  RagPipeline,
  RagPipelineConfig,
  RetrievalResult,
} from "./types";

// ---------------------------------------------------------------------------
// Pipeline factory
// ---------------------------------------------------------------------------

export function createRagPipeline(config: RagPipelineConfig): RagPipeline {
  return {
    async ingest(documents: Document[]): Promise<void> {
      await runPromise(ingestEffect(config, documents));
    },

    async ingestFile(path: string): Promise<void> {
      await runPromise(ingestEffect(config, [loadDocument(path)]));
    },

    async retrieve(
      query: string,
      opts?: { topK?: number },
    ): Promise<RetrievalResult[]> {
      return runPromise(retrieveEffect(config, query, opts?.topK));
    },
  };
}

// ---------------------------------------------------------------------------
// Effect-based pipeline functions
// ---------------------------------------------------------------------------

export function ingestEffect(config: RagPipelineConfig, documents: Document[]) {
  return Effect.scoped(Effect.gen(function* () {
    const vectorStore = yield* acquireVectorStore(config.vectorStore);
    const allChunks = documents.flatMap((doc) => chunk(doc, config.chunkOptions));
    const embedded = yield* embedChunksEffect(allChunks, config.embeddingModel);
    yield* fromPromise("rag pipeline upsert", () =>
      vectorStore.upsert(embedded, config.namespace),
    );
    yield* Metric.incrementBy(ragIngestCount, documents.length);
  })).pipe(
    Effect.annotateLogs({ operation: "ragIngest", docCount: documents.length }),
    Effect.withLogSpan("rag:ingest"),
  );
}

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
