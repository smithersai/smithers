import type { EmbeddingModel } from "ai";
import { Effect, Metric } from "effect";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import type { VectorStore, RetrievalResult } from "../rag/types";
import { embedQueryEffect, embedChunksEffect } from "../rag/embedder";
import type { SmithersError } from "../utils/errors";
import { nowMs } from "../utils/time";
import type { MemoryNamespace, SemanticRecallConfig } from "./types";
import { namespaceToString } from "./types";
import { memoryRecallQueries, memoryRecallDuration } from "./metrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SemanticMemory = {
  remember: (ns: MemoryNamespace, content: string, metadata?: Record<string, unknown>) => Promise<void>;
  recall: (ns: MemoryNamespace, query: string, config?: SemanticRecallConfig) => Promise<RetrievalResult[]>;

  // Effect variants
  rememberEffect: (ns: MemoryNamespace, content: string, metadata?: Record<string, unknown>) => Effect.Effect<void, SmithersError>;
  recallEffect: (ns: MemoryNamespace, query: string, config?: SemanticRecallConfig) => Effect.Effect<RetrievalResult[], SmithersError>;
};

// ---------------------------------------------------------------------------
// Namespace prefix for memory vectors (to separate from RAG vectors)
// ---------------------------------------------------------------------------

function memoryVectorNamespace(ns: MemoryNamespace): string {
  return `memory:${namespaceToString(ns)}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSemanticMemory(
  vectorStore: VectorStore,
  embeddingModel: EmbeddingModel,
): SemanticMemory {
  function rememberEffect(
    ns: MemoryNamespace,
    content: string,
    metadata?: Record<string, unknown>,
  ): Effect.Effect<void, SmithersError> {
    return Effect.gen(function* () {
      const nsStr = memoryVectorNamespace(ns);
      const chunkId = crypto.randomUUID();

      // Create a chunk from the content
      const chunk = {
        id: chunkId,
        documentId: `memory-${chunkId}`,
        content,
        index: 0,
        metadata: {
          ...metadata,
          memoryNamespace: namespaceToString(ns),
          storedAtMs: nowMs(),
        },
      };

      // Embed
      const embedded = yield* embedChunksEffect([chunk], embeddingModel);

      // Upsert into vector store
      yield* fromPromise("memory vector upsert", () =>
        vectorStore.upsert(embedded, nsStr),
      );
    }).pipe(
      Effect.annotateLogs({ operation: "memoryRemember" }),
      Effect.withLogSpan("memory:remember"),
    );
  }

  function recallEffect(
    ns: MemoryNamespace,
    query: string,
    config?: SemanticRecallConfig,
  ): Effect.Effect<RetrievalResult[], SmithersError> {
    return Effect.gen(function* () {
      yield* Metric.increment(memoryRecallQueries);
      const start = performance.now();
      const nsStr = memoryVectorNamespace(ns);
      const topK = config?.topK ?? 10;
      const threshold = config?.similarityThreshold ?? 0;

      // Embed the query
      const embedding = yield* embedQueryEffect(query, embeddingModel);

      // Query the vector store directly via fromPromise to get proper typing
      const results = yield* fromPromise("memory vector query", () =>
        vectorStore.query(embedding, { namespace: nsStr, topK }),
      );

      yield* Metric.update(memoryRecallDuration, performance.now() - start);

      // Filter by similarity threshold
      if (threshold > 0) {
        return results.filter((r: RetrievalResult) => r.score >= threshold);
      }
      return results;
    }).pipe(
      Effect.annotateLogs({ operation: "memoryRecall" }),
      Effect.withLogSpan("memory:recall"),
    );
  }

  return {
    remember: (ns, content, metadata) => runPromise(rememberEffect(ns, content, metadata)),
    recall: (ns, query, config) => runPromise(recallEffect(ns, query, config)),
    rememberEffect,
    recallEffect,
  };
}
