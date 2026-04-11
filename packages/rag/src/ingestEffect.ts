import { Effect, Metric } from "effect";
import { fromPromise } from "@smithers/driver/interop";
import { chunk } from "./chunker";
import { embedChunksEffect } from "./embedder";
import { ragIngestCount } from "./ragIngestCount";
import { acquireVectorStore } from "./vector-store";
import type { Document } from "./document";
import type { RagPipelineConfig } from "./RagPipelineConfig";

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
