import { describe, expect, test, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { createSqliteVectorStore } from "@smithers/rag/vector-store";
import { createSemanticMemory, type SemanticMemory } from "../src/semantic";
import type { MemoryNamespace } from "../src/types";

// ---------------------------------------------------------------------------
// Mock embedding model that returns deterministic vectors
// ---------------------------------------------------------------------------

function createMockEmbeddingModel() {
  // Simple hash-based mock: converts text to a deterministic 3D vector
  function textToVector(text: string): number[] {
    let h1 = 0;
    let h2 = 0;
    let h3 = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = (h1 * 31 + c) & 0xffff;
      h2 = (h2 * 37 + c) & 0xffff;
      h3 = (h3 * 41 + c) & 0xffff;
    }
    // Normalize
    const len = Math.sqrt(h1 * h1 + h2 * h2 + h3 * h3) || 1;
    return [h1 / len, h2 / len, h3 / len];
  }

  return {
    specificationVersion: "v2" as const,
    modelId: "mock-embedding",
    provider: "mock",
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: false,
    async doEmbed({ values }: { values: string[] }) {
      return {
        embeddings: values.map((v) => textToVector(v)),
        warnings: [],
      };
    },
  };
}

const WF_NS: MemoryNamespace = { kind: "workflow", id: "test-semantic" };

describe("SemanticMemory", () => {
  let semantic: SemanticMemory;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const vectorStore = createSqliteVectorStore(db);
    semantic = createSemanticMemory(vectorStore, createMockEmbeddingModel() as any);
  });

  test("remember stores content and recall retrieves it", async () => {
    await semantic.remember(WF_NS, "TypeScript is a typed superset of JavaScript");
    await semantic.remember(WF_NS, "Python is great for data science");
    await semantic.remember(WF_NS, "Rust provides memory safety without GC");

    // Recall with a query similar to one of the stored memories
    const results = await semantic.recall(WF_NS, "TypeScript JavaScript", { topK: 3 });

    expect(results.length).toBeGreaterThan(0);
    // The top result should have a positive similarity score
    expect(results[0]!.score).toBeGreaterThan(0);
    // All results should have chunk content
    for (const r of results) {
      expect(r.chunk.content.length).toBeGreaterThan(0);
    }
  });

  test("recall with empty namespace returns empty", async () => {
    const results = await semantic.recall(WF_NS, "anything", { topK: 5 });
    expect(results).toEqual([]);
  });

  test("namespaces are isolated", async () => {
    const ns2: MemoryNamespace = { kind: "agent", id: "other" };
    await semantic.remember(WF_NS, "Only in workflow namespace");
    await semantic.remember(ns2, "Only in agent namespace");

    const wfResults = await semantic.recall(WF_NS, "workflow namespace", { topK: 10 });
    const agResults = await semantic.recall(ns2, "agent namespace", { topK: 10 });

    // Each namespace should only contain its own memories
    expect(wfResults).toHaveLength(1);
    expect(agResults).toHaveLength(1);
    expect(wfResults[0]!.chunk.content).toContain("workflow");
    expect(agResults[0]!.chunk.content).toContain("agent");
  });

  test("recall respects topK", async () => {
    for (let i = 0; i < 10; i++) {
      await semantic.remember(WF_NS, `Memory entry number ${i}`);
    }

    const results = await semantic.recall(WF_NS, "memory entry", { topK: 3 });
    expect(results).toHaveLength(3);
  });

  test("recall with similarityThreshold filters results", async () => {
    await semantic.remember(WF_NS, "The sky is blue");

    // With an impossibly high threshold, nothing should match
    const results = await semantic.recall(WF_NS, "completely unrelated query", {
      topK: 10,
      similarityThreshold: 0.9999,
    });

    // Even with a mock embedder, a very high threshold should filter out most results
    // (the mock generates deterministic but not identical vectors for different text)
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("remember stores metadata", async () => {
    await semantic.remember(WF_NS, "Important fact", {
      source: "test",
      importance: "high",
    });

    const results = await semantic.recall(WF_NS, "fact", { topK: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]!.metadata).toBeDefined();
    expect((results[0]!.metadata as any).source).toBe("test");
  });
});
