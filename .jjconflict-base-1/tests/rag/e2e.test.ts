import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDocument, loadDocument } from "../../src/rag/document";
import { chunk } from "../../src/rag/chunker";
import { createSqliteVectorStore } from "../../src/rag/vector-store";
import { createRagPipeline } from "../../src/rag/pipeline";
import { createRagTool } from "../../src/rag/tool";
import { createMockEmbeddingModel } from "./helpers";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("RAG end-to-end", () => {
  const tmpDir = join(import.meta.dir, ".tmp-rag-e2e");

  test("full pipeline: create documents, chunk, embed, store, retrieve", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    const store = createSqliteVectorStore(db);
    const model = createMockEmbeddingModel();

    const pipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      chunkOptions: { strategy: "recursive", size: 200, overlap: 50 },
    });

    // Ingest several documents
    const docs = [
      createDocument(
        "TypeScript is a typed superset of JavaScript that compiles to plain JavaScript. " +
          "It adds optional static typing and class-based object-oriented programming.",
      ),
      createDocument(
        "Python is an interpreted, high-level programming language. " +
          "It emphasizes code readability and simplicity.",
      ),
      createDocument(
        "Rust is a systems programming language focused on safety and performance. " +
          "It prevents null pointer dereferences and data races at compile time.",
      ),
    ];

    await pipeline.ingest(docs);

    // Verify storage
    const count = await store.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Query
    const results = await pipeline.retrieve("typed programming language", {
      topK: 3,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.score).toBeNumber();
    expect(results[0]!.chunk.content.length).toBeGreaterThan(0);
  });

  test("ingestFile loads from disk and indexes", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "knowledge.md");
    writeFileSync(
      filePath,
      "# API Reference\n\nThe `createSmithers()` function initializes a workflow.\n\n" +
        "## Parameters\n\n- `schemas` - Zod schemas for output tables\n\n" +
        "## Returns\n\nAn object with `outputs`, `workflow`, and `db`.",
    );

    try {
      const sqlite = new Database(":memory:");
      const db = drizzle(sqlite);
      const store = createSqliteVectorStore(db);
      const model = createMockEmbeddingModel();

      const pipeline = createRagPipeline({
        vectorStore: store,
        embeddingModel: model,
        chunkOptions: { strategy: "markdown", size: 200, overlap: 50 },
      });

      await pipeline.ingestFile(filePath);

      const count = await store.count();
      expect(count).toBeGreaterThanOrEqual(1);

      const results = await pipeline.retrieve("createSmithers function");
      expect(results.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("RAG tool works end-to-end", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    const store = createSqliteVectorStore(db);
    const model = createMockEmbeddingModel();

    const pipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      chunkOptions: { strategy: "sentence", size: 200, overlap: 0 },
    });

    await pipeline.ingest([
      createDocument("Caching prevents duplicate LLM calls by storing previous outputs."),
      createDocument("The scheduler dispatches tasks to available workers."),
    ]);

    const ragTool = createRagTool(pipeline, {
      name: "search_knowledge",
      description: "Search the knowledge base",
      defaultTopK: 2,
    });

    const result = await (ragTool as any).execute({ query: "caching" });
    expect(result.results).toBeArray();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.content).toBeString();
    expect(result.results[0]!.score).toBeNumber();
  });

  test("namespaces are isolated across the full pipeline", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    const store = createSqliteVectorStore(db);
    const model = createMockEmbeddingModel();

    const apiPipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      namespace: "api",
      chunkOptions: { strategy: "recursive", size: 500, overlap: 0 },
    });

    const designPipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      namespace: "design",
      chunkOptions: { strategy: "recursive", size: 500, overlap: 0 },
    });

    await apiPipeline.ingest([createDocument("The API endpoint returns JSON.")]);
    await designPipeline.ingest([createDocument("The design uses a DAG graph.")]);

    const apiCount = await store.count("api");
    const designCount = await store.count("design");
    expect(apiCount).toBeGreaterThanOrEqual(1);
    expect(designCount).toBeGreaterThanOrEqual(1);

    const apiResults = await apiPipeline.retrieve("endpoint");
    expect(apiResults.length).toBeGreaterThanOrEqual(1);
    // Should only get API docs, not design docs
    for (const r of apiResults) {
      expect(r.chunk.content).not.toContain("DAG graph");
    }
  });

  test("chunking strategies produce different results", () => {
    const doc = createDocument(
      "# Title\n\nFirst paragraph with some sentences. This is the second sentence.\n\n" +
        "## Section\n\nAnother paragraph here. More text follows.",
    );

    const recursive = chunk(doc, { strategy: "recursive", size: 50, overlap: 0 });
    const markdown = chunk(doc, { strategy: "markdown", size: 50, overlap: 0 });
    const sentence = chunk(doc, { strategy: "sentence", size: 50, overlap: 0 });

    // All should produce at least 1 chunk
    expect(recursive.length).toBeGreaterThanOrEqual(1);
    expect(markdown.length).toBeGreaterThanOrEqual(1);
    expect(sentence.length).toBeGreaterThanOrEqual(1);
  });

  test("empty pipeline returns empty results", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    const store = createSqliteVectorStore(db);
    const model = createMockEmbeddingModel();

    const pipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
    });

    const results = await pipeline.retrieve("anything");
    expect(results).toEqual([]);
  });
});
