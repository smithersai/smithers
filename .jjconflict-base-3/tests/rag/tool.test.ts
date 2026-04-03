import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createSqliteVectorStore } from "../../src/rag/vector-store";
import { createRagPipeline } from "../../src/rag/pipeline";
import { createRagTool } from "../../src/rag/tool";
import { createDocument } from "../../src/rag/document";
import { createMockEmbeddingModel } from "./helpers";

describe("createRagTool", () => {
  let pipeline: ReturnType<typeof createRagPipeline>;

  beforeEach(async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    const store = createSqliteVectorStore(db);
    const model = createMockEmbeddingModel();
    pipeline = createRagPipeline({
      vectorStore: store,
      embeddingModel: model,
      chunkOptions: { strategy: "recursive", size: 500, overlap: 0 },
    });
    await pipeline.ingest([
      createDocument("TypeScript is a typed superset of JavaScript."),
      createDocument("Smithers is a workflow orchestrator."),
    ]);
  });

  test("creates a tool with default options", () => {
    const ragTool = createRagTool(pipeline);
    expect(ragTool).toBeDefined();
    expect(ragTool.description).toBe(
      "Search the knowledge base for relevant documents",
    );
  });

  test("creates a tool with custom options", () => {
    const ragTool = createRagTool(pipeline, {
      name: "search_docs",
      description: "Search project documentation",
      defaultTopK: 3,
    });
    expect(ragTool.description).toBe("Search project documentation");
  });

  test("tool execute returns results", async () => {
    const ragTool = createRagTool(pipeline);
    const result = await (ragTool as any).execute({
      query: "TypeScript",
      topK: 2,
    });
    expect(result.results).toBeArray();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.content).toBeString();
    expect(result.results[0]!.score).toBeNumber();
  });

  test("tool execute uses default topK", async () => {
    const ragTool = createRagTool(pipeline, { defaultTopK: 1 });
    const result = await (ragTool as any).execute({
      query: "language",
    });
    expect(result.results.length).toBeLessThanOrEqual(1);
  });
});
