import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { createMemoryStore } from "../src/store/index.js";
import { TtlGarbageCollector } from "../src/processors.js";
import { namespaceToString, parseNamespace } from "../src/types.js";
const WF_NS = { kind: "workflow", id: "e2e-test" };
describe("Memory E2E", () => {
    let store;
    beforeEach(() => {
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        store = createMemoryStore(db);
    });
    test("full workflow: set facts, store messages, check persistence", async () => {
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
        // 3. Verify working memory persists
        const facts = await store.listFacts(WF_NS);
        expect(facts).toHaveLength(3);
        const modelFact = await store.getFact(WF_NS, "model");
        expect(JSON.parse(modelFact.valueJson)).toBe("gpt-4");
        // 4. Verify message history persists
        const messages = await store.listMessages(thread.threadId);
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe("user");
        expect(messages[1].role).toBe("assistant");
        const count = await store.countMessages(thread.threadId);
        expect(count).toBe(2);
    });
    test("multiple runs accumulate facts", async () => {
        // Simulate run 1
        await store.setFact(WF_NS, "run-count", 1);
        await store.setFact(WF_NS, "last-result", "success");
        // Simulate run 2 (increments counter, updates result)
        const prev = await store.getFact(WF_NS, "run-count");
        const count = JSON.parse(prev.valueJson);
        await store.setFact(WF_NS, "run-count", count + 1);
        await store.setFact(WF_NS, "last-result", "failure");
        // Verify accumulated state
        const runCount = await store.getFact(WF_NS, "run-count");
        expect(JSON.parse(runCount.valueJson)).toBe(2);
        const lastResult = await store.getFact(WF_NS, "last-result");
        expect(JSON.parse(lastResult.valueJson)).toBe("failure");
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
        const ns1 = { kind: "workflow", id: "flow-a" };
        const ns2 = { kind: "workflow", id: "flow-b" };
        // Store facts in different namespaces
        await store.setFact(ns1, "key", "value-a");
        await store.setFact(ns2, "key", "value-b");
        // Verify isolation
        const factA = await store.getFact(ns1, "key");
        const factB = await store.getFact(ns2, "key");
        expect(JSON.parse(factA.valueJson)).toBe("value-a");
        expect(JSON.parse(factB.valueJson)).toBe("value-b");
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
