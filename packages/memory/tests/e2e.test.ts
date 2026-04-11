import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { createMemoryStore, type MemoryStore } from "../src/store";
import { createSqliteVectorStore } from "@smithers/rag/vector-store";
import { createSemanticMemory, type SemanticMemory } from "../src/semantic";
import { TtlGarbageCollector } from "../src/processors";
import { namespaceToString, parseNamespace } from "../src/types";
import type { MemoryNamespace } from "../src/types";

function createMockEmbeddingModel() {
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
      return { embeddings: values.map((v) => textToVector(v)), warnings: [] };
    },
  };
}

const WF_NS: MemoryNamespace = { kind: "workflow", id: "e2e-test" };

describe("Memory E2E", () => {
  let store: MemoryStore;
  let semantic: SemanticMemory;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    store = createMemoryStore(db);
    const vectorStore = createSqliteVectorStore(db);
    semantic = createSemanticMemory(vectorStore, createMockEmbeddingModel() as any);
  });

  test("full workflow: set facts, store semantic, recall, check persistence", async () => {
    // 1. Store working memory facts
    await store.setFact(WF_NS, "model", "gpt-4");
    await store.setFact(WF_NS, "temperature", 0.7);
    await store.setFact(WF_NS, "max-tokens", 4096);

    // 2. Create a thread and store messages
    const thread = await store.createThread(WF_NS, "E2E Session");

    await store.saveMessage({
      id: "msg-1",
      threadId: thread.threadId,
      role: "user",
      contentJson: JSON.stringify({ text: "Analyze this codebase" }),
      runId: "run-001",
      nodeId: "analyze-task",
    });

    await store.saveMessage({
      id: "msg-2",
      threadId: thread.threadId,
      role: "assistant",
      contentJson: JSON.stringify({
        text: "Found 5 modules with 12 dependencies",
        modules: ["auth", "db", "api", "ui", "utils"],
      }),
      runId: "run-001",
      nodeId: "analyze-task",
    });

    // 3. Store semantic memories
    await semantic.remember(WF_NS, "The auth module has a SQL injection vulnerability in the login handler");
    await semantic.remember(WF_NS, "The UI module uses React 18 with concurrent features");
    await semantic.remember(WF_NS, "The database layer uses Drizzle ORM with SQLite");

    // 4. Verify working memory persists
    const facts = await store.listFacts(WF_NS);
    expect(facts).toHaveLength(3);

    const modelFact = await store.getFact(WF_NS, "model");
    expect(JSON.parse(modelFact!.valueJson)).toBe("gpt-4");

    // 5. Verify message history persists
    const messages = await store.listMessages(thread.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    const count = await store.countMessages(thread.threadId);
    expect(count).toBe(2);

    // 6. Verify semantic recall works
    const securityResults = await semantic.recall(WF_NS, "security vulnerability", { topK: 3 });
    expect(securityResults.length).toBeGreaterThan(0);

    const uiResults = await semantic.recall(WF_NS, "React frontend UI", { topK: 3 });
    expect(uiResults.length).toBeGreaterThan(0);
  });

  test("multiple runs accumulate facts", async () => {
    // Simulate run 1
    await store.setFact(WF_NS, "run-count", 1);
    await store.setFact(WF_NS, "last-result", "success");

    // Simulate run 2 (increments counter, updates result)
    const prev = await store.getFact(WF_NS, "run-count");
    const count = JSON.parse(prev!.valueJson) as number;
    await store.setFact(WF_NS, "run-count", count + 1);
    await store.setFact(WF_NS, "last-result", "failure");

    // Verify accumulated state
    const runCount = await store.getFact(WF_NS, "run-count");
    expect(JSON.parse(runCount!.valueJson)).toBe(2);

    const lastResult = await store.getFact(WF_NS, "last-result");
    expect(JSON.parse(lastResult!.valueJson)).toBe("failure");
  });

  test("TTL garbage collection in workflow context", async () => {
    // Store a mix of ephemeral and permanent facts
    await store.setFact(WF_NS, "cache-entry", "cached-data", 1); // 1ms TTL
    await store.setFact(WF_NS, "config", "permanent-config"); // no TTL

    // Wait for ephemeral to expire
    await new Promise((r) => setTimeout(r, 10));

    // Run GC
    const gc = TtlGarbageCollector();
    await gc.process(store);

    // Only permanent fact should survive
    const cache = await store.getFact(WF_NS, "cache-entry");
    const config = await store.getFact(WF_NS, "config");
    expect(cache).toBeUndefined();
    expect(config).toBeDefined();
  });

  test("namespace isolation end-to-end", async () => {
    const ns1: MemoryNamespace = { kind: "workflow", id: "flow-a" };
    const ns2: MemoryNamespace = { kind: "workflow", id: "flow-b" };

    // Store facts in different namespaces
    await store.setFact(ns1, "key", "value-a");
    await store.setFact(ns2, "key", "value-b");

    // Store semantic memories in different namespaces
    await semantic.remember(ns1, "Flow A memory content");
    await semantic.remember(ns2, "Flow B memory content");

    // Verify isolation
    const factA = await store.getFact(ns1, "key");
    const factB = await store.getFact(ns2, "key");
    expect(JSON.parse(factA!.valueJson)).toBe("value-a");
    expect(JSON.parse(factB!.valueJson)).toBe("value-b");

    const recallA = await semantic.recall(ns1, "memory content", { topK: 10 });
    const recallB = await semantic.recall(ns2, "memory content", { topK: 10 });
    expect(recallA).toHaveLength(1);
    expect(recallB).toHaveLength(1);
    expect(recallA[0]!.chunk.content).toContain("Flow A");
    expect(recallB[0]!.chunk.content).toContain("Flow B");
  });

  test("thread and message operations with multiple threads", async () => {
    const thread1 = await store.createThread(WF_NS, "Thread 1");
    const thread2 = await store.createThread(WF_NS, "Thread 2");

    await store.saveMessage({
      id: "t1-msg-1",
      threadId: thread1.threadId,
      role: "user",
      contentJson: '"Thread 1 message"',
    });
    await store.saveMessage({
      id: "t2-msg-1",
      threadId: thread2.threadId,
      role: "user",
      contentJson: '"Thread 2 message"',
    });
    await store.saveMessage({
      id: "t2-msg-2",
      threadId: thread2.threadId,
      role: "assistant",
      contentJson: '"Thread 2 reply"',
    });

    const t1Messages = await store.listMessages(thread1.threadId);
    const t2Messages = await store.listMessages(thread2.threadId);

    expect(t1Messages).toHaveLength(1);
    expect(t2Messages).toHaveLength(2);

    // Delete thread 1 should not affect thread 2
    await store.deleteThread(thread1.threadId);
    const t2MessagesAfter = await store.listMessages(thread2.threadId);
    expect(t2MessagesAfter).toHaveLength(2);

    const t1MessagesAfter = await store.listMessages(thread1.threadId);
    expect(t1MessagesAfter).toHaveLength(0);
  });
});
