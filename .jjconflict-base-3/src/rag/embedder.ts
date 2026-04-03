import { embed, embedMany, type EmbeddingModel } from "ai";
import { Effect, Metric } from "effect";
import { fromPromise } from "../effect/interop";
import type { SmithersError } from "../utils/errors";
import { ragEmbedDuration } from "./metrics";
import type { Chunk, EmbeddedChunk } from "./types";

// ---------------------------------------------------------------------------
// embedChunks — wraps AI SDK embedMany()
// ---------------------------------------------------------------------------

export function embedChunksEffect(
  chunks: Chunk[],
  model: EmbeddingModel,
): Effect.Effect<EmbeddedChunk[], SmithersError> {
  return Effect.gen(function* () {
    if (chunks.length === 0) return [] as EmbeddedChunk[];

    const start = performance.now();
    const { embeddings } = yield* fromPromise(
      "rag embed chunks",
      () =>
        embedMany({
          model,
          values: chunks.map((c) => c.content),
        }),
    );
    yield* Metric.update(ragEmbedDuration, performance.now() - start);

    return chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i]! as number[],
    }));
  }).pipe(
    Effect.annotateLogs({ operation: "embedChunks", count: chunks.length }),
    Effect.withLogSpan("rag:embed-chunks"),
  );
}

export async function embedChunks(
  chunks: Chunk[],
  model: EmbeddingModel,
): Promise<EmbeddedChunk[]> {
  if (chunks.length === 0) return [];

  const { embeddings } = await embedMany({
    model,
    values: chunks.map((c) => c.content),
  });

  return chunks.map((chunk, i) => ({
    ...chunk,
    embedding: embeddings[i]! as number[],
  }));
}

// ---------------------------------------------------------------------------
// embedQuery — wraps AI SDK embed()
// ---------------------------------------------------------------------------

export function embedQueryEffect(
  query: string,
  model: EmbeddingModel,
): Effect.Effect<number[], SmithersError> {
  return Effect.gen(function* () {
    const start = performance.now();
    const { embedding } = yield* fromPromise("rag embed query", () =>
      embed({ model, value: query }),
    );
    yield* Metric.update(ragEmbedDuration, performance.now() - start);
    return embedding as number[];
  }).pipe(
    Effect.annotateLogs({ operation: "embedQuery" }),
    Effect.withLogSpan("rag:embed-query"),
  );
}

export async function embedQuery(
  query: string,
  model: EmbeddingModel,
): Promise<number[]> {
  const { embedding } = await embed({ model, value: query });
  return embedding as number[];
}
