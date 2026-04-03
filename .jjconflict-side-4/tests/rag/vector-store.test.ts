import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createSqliteVectorStore } from "../../src/rag/vector-store";
import type { EmbeddedChunk } from "../../src/rag/types";

function makeDb() {
  const sqlite = new Database(":memory:");
  return drizzle(sqlite);
}

function makeChunk(
  id: string,
  embedding: number[],
  content = "test content",
): EmbeddedChunk {
  return {
    id,
    documentId: "doc1",
    content,
    index: 0,
    embedding,
  };
}

describe("createSqliteVectorStore", () => {
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    db = makeDb();
  });

  test("creates the vector table", () => {
    const store = createSqliteVectorStore(db);
    // Should not throw
    expect(store).toBeDefined();
  });

  test("upsert and count", async () => {
    const store = createSqliteVectorStore(db);
    const chunks: EmbeddedChunk[] = [
      makeChunk("c1", [1, 0, 0]),
      makeChunk("c2", [0, 1, 0]),
      makeChunk("c3", [0, 0, 1]),
    ];
    await store.upsert(chunks);
    const count = await store.count();
    expect(count).toBe(3);
  });

  test("upsert replaces existing entries", async () => {
    const store = createSqliteVectorStore(db);
    await store.upsert([makeChunk("c1", [1, 0, 0], "original")]);
    await store.upsert([makeChunk("c1", [1, 0, 0], "updated")]);
    const count = await store.count();
    expect(count).toBe(1);
    const results = await store.query([1, 0, 0], { topK: 1 });
    expect(results[0]!.chunk.content).toBe("updated");
  });

  test("query returns results sorted by similarity", async () => {
    const store = createSqliteVectorStore(db);
    await store.upsert([
      makeChunk("c1", [1, 0, 0], "close match"),
      makeChunk("c2", [0, 1, 0], "orthogonal"),
      makeChunk("c3", [0.9, 0.1, 0], "near match"),
    ]);
    const results = await store.query([1, 0, 0], { topK: 3 });
    expect(results.length).toBe(3);
    // The closest match should be first
    expect(results[0]!.chunk.content).toBe("close match");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  test("query respects topK", async () => {
    const store = createSqliteVectorStore(db);
    await store.upsert([
      makeChunk("c1", [1, 0, 0]),
      makeChunk("c2", [0, 1, 0]),
      makeChunk("c3", [0, 0, 1]),
    ]);
    const results = await store.query([1, 0, 0], { topK: 1 });
    expect(results.length).toBe(1);
  });

  test("namespaces are isolated", async () => {
    const store = createSqliteVectorStore(db);
    await store.upsert([makeChunk("c1", [1, 0, 0])], "ns1");
    await store.upsert([makeChunk("c2", [0, 1, 0])], "ns2");

    const ns1Count = await store.count("ns1");
    expect(ns1Count).toBe(1);

    const ns2Count = await store.count("ns2");
    expect(ns2Count).toBe(1);

    const ns1Results = await store.query([1, 0, 0], {
      topK: 10,
      namespace: "ns1",
    });
    expect(ns1Results.length).toBe(1);
    expect(ns1Results[0]!.chunk.id).toBe("c1");
  });

  test("delete removes entries", async () => {
    const store = createSqliteVectorStore(db);
    await store.upsert([
      makeChunk("c1", [1, 0, 0]),
      makeChunk("c2", [0, 1, 0]),
    ]);
    await store.delete(["c1"]);
    const count = await store.count();
    expect(count).toBe(1);
  });

  test("delete with empty array does nothing", async () => {
    const store = createSqliteVectorStore(db);
    await store.upsert([makeChunk("c1", [1, 0, 0])]);
    await store.delete([]);
    const count = await store.count();
    expect(count).toBe(1);
  });

  test("count returns 0 for empty namespace", async () => {
    const store = createSqliteVectorStore(db);
    const count = await store.count("nonexistent");
    expect(count).toBe(0);
  });

  test("query returns empty for empty namespace", async () => {
    const store = createSqliteVectorStore(db);
    const results = await store.query([1, 0, 0], { namespace: "empty" });
    expect(results.length).toBe(0);
  });

  test("preserves metadata through round-trip", async () => {
    const store = createSqliteVectorStore(db);
    const chunk: EmbeddedChunk = {
      id: "c1",
      documentId: "doc1",
      content: "test",
      index: 0,
      embedding: [1, 0, 0],
      metadata: { source: "test.md", page: 3 },
    };
    await store.upsert([chunk]);
    const results = await store.query([1, 0, 0], { topK: 1 });
    expect(results[0]!.metadata).toEqual({ source: "test.md", page: 3 });
  });

  test("handles high-dimensional vectors", async () => {
    const store = createSqliteVectorStore(db);
    const dim = 384;
    const vec = new Array(dim).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    await store.upsert([makeChunk("c1", vec)]);
    const results = await store.query(vec, { topK: 1 });
    expect(results.length).toBe(1);
    expect(results[0]!.score).toBeCloseTo(1, 2);
  });
});
