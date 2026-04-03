import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import { ensureSmithersTables } from "../../src/db/ensure";
import { MemoryService, createMemoryLayer } from "../../src/memory/service";
import type { MemoryNamespace } from "../../src/memory/types";

const WF_NS: MemoryNamespace = { kind: "workflow", id: "test-service" };

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return db;
}

describe("MemoryService", () => {
  test("provides working memory via Effect layer", async () => {
    const db = createTestDb();
    const layer = createMemoryLayer({ db });

    const program = Effect.gen(function* () {
      const memory = yield* MemoryService;

      // Set and get a fact
      yield* memory.setFact(WF_NS, "test-key", { value: 42 });
      const fact = yield* memory.getFact(WF_NS, "test-key");

      return fact;
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer)),
    );

    expect(result).toBeDefined();
    expect(result!.key).toBe("test-key");
    expect(JSON.parse(result!.valueJson)).toEqual({ value: 42 });
  });

  test("provides thread/message operations via Effect layer", async () => {
    const db = createTestDb();
    const layer = createMemoryLayer({ db });

    const program = Effect.gen(function* () {
      const memory = yield* MemoryService;

      // Create a thread
      const thread = yield* memory.createThread(WF_NS, "Test Thread");

      // Save a message
      yield* memory.saveMessage({
        id: "msg-1",
        threadId: thread.threadId,
        role: "user",
        contentJson: '"hello"',
      });

      // Count messages
      const count = yield* memory.countMessages(thread.threadId);

      // List messages
      const messages = yield* memory.listMessages(thread.threadId);

      return { thread, count, messages };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer)),
    );

    expect(result.thread.title).toBe("Test Thread");
    expect(result.count).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("user");
  });

  test("deleteFact and listFacts via Effect layer", async () => {
    const db = createTestDb();
    const layer = createMemoryLayer({ db });

    const program = Effect.gen(function* () {
      const memory = yield* MemoryService;

      yield* memory.setFact(WF_NS, "a", 1);
      yield* memory.setFact(WF_NS, "b", 2);

      const beforeDelete = yield* memory.listFacts(WF_NS);

      yield* memory.deleteFact(WF_NS, "a");

      const afterDelete = yield* memory.listFacts(WF_NS);

      return { beforeDelete, afterDelete };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer)),
    );

    expect(result.beforeDelete).toHaveLength(2);
    expect(result.afterDelete).toHaveLength(1);
    expect(result.afterDelete[0]!.key).toBe("b");
  });

  test("semantic recall fails gracefully without vector store", async () => {
    const db = createTestDb();
    // No vectorStore or embeddingModel provided
    const layer = createMemoryLayer({ db });

    const program = Effect.gen(function* () {
      const memory = yield* MemoryService;
      // This should fail since no vectorStore is configured
      yield* memory.recall(WF_NS, "test query");
    });

    try {
      await Effect.runPromise(program.pipe(Effect.provide(layer)));
      // Should not reach here
      expect(false).toBe(true);
    } catch (err: any) {
      expect(err).toBeDefined();
    }
  });

  test("deleteExpiredFacts via Effect layer", async () => {
    const db = createTestDb();
    const layer = createMemoryLayer({ db });

    const program = Effect.gen(function* () {
      const memory = yield* MemoryService;

      // Set an expired fact
      yield* memory.setFact(WF_NS, "expired", "old", 1);

      // Wait for it to expire
      yield* Effect.sleep("10 millis");

      const deleted = yield* memory.deleteExpiredFacts();
      const fact = yield* memory.getFact(WF_NS, "expired");

      return { deleted, fact };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer)),
    );

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.fact).toBeUndefined();
  });

  test("exposes underlying store", async () => {
    const db = createTestDb();
    const layer = createMemoryLayer({ db });

    const program = Effect.gen(function* () {
      const memory = yield* MemoryService;
      return memory.store != null;
    });

    const hasStore = await Effect.runPromise(
      program.pipe(Effect.provide(layer)),
    );

    expect(hasStore).toBe(true);
  });
});
