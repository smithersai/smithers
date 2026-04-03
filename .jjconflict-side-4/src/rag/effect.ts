import { Context, Effect, Layer } from "effect";
import type { SmithersError } from "../utils/errors";
import type { Document, RagPipelineConfig, RetrievalResult } from "./types";
import { ingestEffect, retrieveEffect } from "./pipeline";

// ---------------------------------------------------------------------------
// RagService — Effect Context.Tag
// ---------------------------------------------------------------------------

export class RagService extends Context.Tag("RagService")<
  RagService,
  {
    readonly ingest: (
      documents: Document[],
    ) => Effect.Effect<void, SmithersError>;
    readonly retrieve: (
      query: string,
      topK?: number,
    ) => Effect.Effect<RetrievalResult[], SmithersError>;
  }
>() {}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

export function createRagServiceLayer(config: RagPipelineConfig) {
  return Layer.succeed(RagService, {
    ingest: (documents: Document[]) => ingestEffect(config, documents),
    retrieve: (query: string, topK?: number) =>
      retrieveEffect(config, query, topK),
  });
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

export function ingest(documents: Document[]) {
  return Effect.flatMap(RagService, (svc) => svc.ingest(documents));
}

export function retrieve(query: string, topK?: number) {
  return Effect.flatMap(RagService, (svc) => svc.retrieve(query, topK));
}
