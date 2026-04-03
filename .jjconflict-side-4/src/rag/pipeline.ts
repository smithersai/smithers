import { Effect, Metric } from "effect";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { chunk } from "./chunker";
import { createDocument, loadDocument } from "./document";
import { embedChunks, embedQuery, embedChunksEffect, embedQueryEffect } from "./embedder";
import { ragIngestCount, ragRetrieveCount } from "./metrics";
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
  const {
    vectorStore,
    embeddingModel,
    chunkOptions,
    topK: defaultTopK = 10,
    namespace,
  } = config;

  return {
    async ingest(documents: Document[]): Promise<void> {
      const allChunks = documents.flatMap((doc) => chunk(doc, chunkOptions));
      const embedded = await embedChunks(allChunks, embeddingModel);
      await vectorStore.upsert(embedded, namespace);
    },

    async ingestFile(path: string): Promise<void> {
      const doc = loadDocument(path);
      const chunks = chunk(doc, chunkOptions);
      const embedded = await embedChunks(chunks, embeddingModel);
      await vectorStore.upsert(embedded, namespace);
    },

    async retrieve(
      query: string,
      opts?: { topK?: number },
    ): Promise<RetrievalResult[]> {
      const embedding = await embedQuery(query, embeddingModel);
      return vectorStore.query(embedding, {
        topK: opts?.topK ?? defaultTopK,
        namespace,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Effect-based pipeline functions
// ---------------------------------------------------------------------------

export function ingestEffect(config: RagPipelineConfig, documents: Document[]) {
  return Effect.gen(function* () {
    const allChunks = documents.flatMap((doc) => chunk(doc, config.chunkOptions));
    const embedded = yield* embedChunksEffect(allChunks, config.embeddingModel);
    yield* fromPromise("rag pipeline upsert", () =>
      config.vectorStore.upsert(embedded, config.namespace),
    );
    yield* Metric.incrementBy(ragIngestCount, documents.length);
  }).pipe(
    Effect.annotateLogs({ operation: "ragIngest", docCount: documents.length }),
    Effect.withLogSpan("rag:ingest"),
  );
}

export function retrieveEffect(config: RagPipelineConfig, query: string, topK?: number) {
  return Effect.gen(function* () {
    const embedding = yield* embedQueryEffect(query, config.embeddingModel);
    const results = yield* fromPromise("rag pipeline query", () =>
      config.vectorStore.query(embedding, {
        topK: topK ?? config.topK ?? 10,
        namespace: config.namespace,
      }),
    );
    yield* Metric.increment(ragRetrieveCount);
    return results;
  }).pipe(
    Effect.annotateLogs({ operation: "ragRetrieve" }),
    Effect.withLogSpan("rag:retrieve"),
  );
}
