import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createSqliteVectorStore } from "../../src/rag/vector-store";
import { createRagPipeline } from "../../src/rag/pipeline";
import { createDocument } from "../../src/rag/document";
import type { EmbeddingModel } from "ai";
import { createMockEmbeddingModel } from "./helpers";

describe("createRagPipeline", () => {
  let db: ReturnType<typeof drizzle>;
  let store: ReturnType<typeof createSqliteVectorStore>;
  let model: EmbeddingModel;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    store = createSqliteVectorStore(db);
    model = createMockEmbeddingModel();
  });

  test("ingest adds documents to the vector store", async () => {
    const pipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      chunkOptions: { strategy: "recursive", size: 500, overlap: 0 },
    });

    const doc = createDocument("This is a test document about TypeScript.");
    await pipeline.ingest([doc]);

    const count = await store.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("retrieve returns results for a matching query", async () => {
    const pipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      chunkOptions: { strategy: "recursive", size: 500, overlap: 0 },
    });

    await pipeline.ingest([
      createDocument("TypeScript is a typed superset of JavaScript."),
      createDocument("Python is a dynamically typed language."),
    ]);

    const results = await pipeline.retrieve("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.score).toBeNumber();
    expect(results[0]!.chunk.content).toBeString();
  });

  test("retrieve respects topK", async () => {
    const pipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      chunkOptions: { strategy: "recursive", size: 500, overlap: 0 },
    });

    await pipeline.ingest([
      createDocument("Document one about cats."),
      createDocument("Document two about dogs."),
      createDocument("Document three about birds."),
    ]);

    const results = await pipeline.retrieve("animals", { topK: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("namespace isolates documents", async () => {
    const pipeline1 = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      namespace: "ns1",
      chunkOptions: { strategy: "recursive", size: 500, overlap: 0 },
    });

    const pipeline2 = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      namespace: "ns2",
      chunkOptions: { strategy: "recursive", size: 500, overlap: 0 },
    });

    await pipeline1.ingest([createDocument("Cats are great pets.")]);
    await pipeline2.ingest([createDocument("Dogs are loyal companions.")]);

    const ns1Count = await store.count("ns1");
    const ns2Count = await store.count("ns2");
    expect(ns1Count).toBeGreaterThanOrEqual(1);
    expect(ns2Count).toBeGreaterThanOrEqual(1);

    const results = await pipeline1.retrieve("pets");
    for (const r of results) {
      expect(r.chunk.content).toContain("Cats");
    }
  });

  test("ingest with multiple chunks per document", async () => {
    const pipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      chunkOptions: { strategy: "recursive", size: 30, overlap: 0 },
    });

    const longText = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
    await pipeline.ingest([createDocument(longText)]);

    const count = await store.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("uses default topK from config", async () => {
    const pipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      topK: 1,
      chunkOptions: { strategy: "recursive", size: 500, overlap: 0 },
    });

    await pipeline.ingest([
      createDocument("Alpha document."),
      createDocument("Beta document."),
      createDocument("Gamma document."),
    ]);

    const results = await pipeline.retrieve("document");
    expect(results.length).toBeLessThanOrEqual(1);
  });
});
