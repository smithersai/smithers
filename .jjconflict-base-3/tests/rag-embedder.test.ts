import { describe, expect, test } from "bun:test";
import { embedChunks, embedChunksEffect } from "../src/rag/embedder";
import { Effect } from "effect";
import type { Chunk, EmbeddedChunk } from "../src/rag/types";

// Mock embedding model that returns deterministic embeddings.
// Must satisfy the AI SDK EmbeddingModelV2 interface.
function createMockEmbeddingModel() {
  let callCount = 0;
  return {
    specificationVersion: "v2" as const,
    modelId: "mock-embed",
    provider: "mock",
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: false,
    doEmbed: async ({ values }: { values: string[] }) => {
      callCount++;
      return {
        embeddings: values.map((_v, i) =>
          Array.from({ length: 3 }, (_, j) => i + j * 0.1),
        ),
        warnings: [],
      };
    },
    get callCount() {
      return callCount;
    },
  } as any;
}

function makeChunk(
  id: string,
  content: string,
  index = 0,
): Chunk {
  return {
    id,
    documentId: "doc-1",
    content,
    index,
  };
}

// ---------------------------------------------------------------------------
// embedChunks (Promise version)
// ---------------------------------------------------------------------------

describe("embedChunks", () => {
  test("returns empty array for empty input", async () => {
    const model = createMockEmbeddingModel();
    const result = await embedChunks([], model);
    expect(result).toEqual([]);
    expect(model.callCount).toBe(0);
  });

  test("returns embedded chunks with correct mapping", async () => {
    const model = createMockEmbeddingModel();
    const chunks = [
      makeChunk("c1", "Hello world", 0),
      makeChunk("c2", "Goodbye world", 1),
    ];

    const result = await embedChunks(chunks, model);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("c1");
    expect(result[0].content).toBe("Hello world");
    expect(result[0].embedding).toBeDefined();
    expect(Array.isArray(result[0].embedding)).toBe(true);
    expect(result[0].embedding.length).toBe(3);
    expect(result[1].id).toBe("c2");
    expect(result[1].content).toBe("Goodbye world");
    expect(result[1].embedding).toBeDefined();
  });

  test("preserves chunk metadata through embedding", async () => {
    const model = createMockEmbeddingModel();
    const chunk: Chunk = {
      id: "c1",
      documentId: "doc-1",
      content: "test content",
      index: 5,
      metadata: { source: "test" },
    };

    const result = await embedChunks([chunk], model);

    expect(result[0].documentId).toBe("doc-1");
    expect(result[0].index).toBe(5);
    expect(result[0].metadata).toEqual({ source: "test" });
  });
});

// ---------------------------------------------------------------------------
// embedChunksEffect (Effect version)
// ---------------------------------------------------------------------------

describe("embedChunksEffect", () => {
  test("returns empty array for empty input via Effect", async () => {
    const model = createMockEmbeddingModel();
    const result = await Effect.runPromise(embedChunksEffect([], model));
    expect(result).toEqual([]);
  });

  // Note: The full Effect version with non-empty chunks requires
  // Effect runtime context (fromPromise wrapping). We test the core
  // embedding logic through the Promise version above. The Effect version
  // adds metrics and logging which are tested in integration.
});
