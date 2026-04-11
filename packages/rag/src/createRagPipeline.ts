import { Effect } from "effect";
import { loadDocument } from "./document";
import { ingestEffect } from "./ingestEffect";
import { retrieveEffect } from "./retrieveEffect";
import type { Document } from "./document";
import type { RagPipeline } from "./RagPipeline";
import type { RagPipelineConfig } from "./RagPipelineConfig";
import type { RetrievalResult } from "./RetrievalResult";

export function createRagPipeline(config: RagPipelineConfig): RagPipeline {
  return {
    async ingest(documents: Document[]): Promise<void> {
      await Effect.runPromise(ingestEffect(config, documents));
    },

    async ingestFile(path: string): Promise<void> {
      await Effect.runPromise(ingestEffect(config, [loadDocument(path)]));
    },

    async retrieve(
      query: string,
      opts?: { topK?: number },
    ): Promise<RetrievalResult[]> {
      return Effect.runPromise(retrieveEffect(config, query, opts?.topK));
    },
  };
}
