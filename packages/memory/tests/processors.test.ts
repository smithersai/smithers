import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { createMemoryStore, type MemoryStore } from "../src/store";
import {
  TtlGarbageCollector,
  TokenLimiter,
  Summarizer,
} from "../src/processors";
import type { MemoryNamespace } from "../src/types";

const WF_NS: MemoryNamespace = { kind: "workflow", id: "test-proc" };

describe("TtlGarbageCollector", () => {
  let store: MemoryStore;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    store = createMemoryStore(db);
  });

  test("deletes expired facts", async () => {
    // Set a fact with very short TTL
    await store.setFact(WF_NS, "ephemeral", "temp", 1);
    // Wait for it to expire
    await new Promise((r) => setTimeout(r, 10));

    // Set a fact without TTL (should survive)
    await store.setFact(WF_NS, "permanent", "stays");

    const gc = TtlGarbageCollector();
    expect(gc.name).toBe("TtlGarbageCollector");
    await gc.process(store);

    const ephemeral = await store.getFact(WF_NS, "ephemeral");
    const permanent = await store.getFact(WF_NS, "permanent");

    expect(ephemeral).toBeUndefined();
    expect(permanent).toBeDefined();
  });

  test("no-op when no expired facts exist", async () => {
    await store.setFact(WF_NS, "long-lived", "value", 999999);
    const gc = TtlGarbageCollector();
    // Should not throw
    await gc.process(store);

    const fact = await store.getFact(WF_NS, "long-lived");
    expect(fact).toBeDefined();
  });
});

describe("TokenLimiter", () => {
  test("creates processor with name", () => {
    const limiter = TokenLimiter(4096);
    expect(limiter.name).toBe("TokenLimiter");
  });

  test("process does not throw", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const store = createMemoryStore(db);

    const limiter = TokenLimiter(4096);
    // Should not throw
    await limiter.process(store);
  });
});

describe("Summarizer", () => {
  test("creates processor with name", () => {
    const mockAgent = { run: async (_prompt: string) => ({ text: "summary" }) };
    const summarizer = Summarizer(mockAgent);
    expect(summarizer.name).toBe("Summarizer");
  });

  test("process does not throw", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const store = createMemoryStore(db);

    const mockAgent = { run: async (_prompt: string) => ({ text: "summary" }) };
    const summarizer = Summarizer(mockAgent);
    // Should not throw
    await summarizer.process(store);
  });
});
