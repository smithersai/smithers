import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { NodeDiffCache } from "../src/cache/nodeDiffCache.js";
import { ensureSmithersTables } from "../src/ensure.js";
function createDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    return { sqlite, adapter };
}
const BUNDLE = {
    seq: 1,
    baseRef: "base",
    patches: [
        {
            path: "foo.txt",
            operation: "modify",
            diff: "diff --git a/foo.txt b/foo.txt\n",
        },
    ],
};
describe("NodeDiffCache", () => {
    test("cold hit writes to DB and warm hit reads without recomputing", async () => {
        const { sqlite, adapter } = createDb();
        const cache = new NodeDiffCache(adapter);
        let computeCalls = 0;
        const key = {
            runId: "run-node-diff",
            nodeId: "task:diff",
            iteration: 0,
            baseRef: "base-1",
        };
        const cold = await cache.getOrCompute(key, async () => {
            computeCalls += 1;
            return BUNDLE;
        });
        const warm = await cache.getOrCompute(key, async () => {
            computeCalls += 1;
            return { ...BUNDLE, seq: 2 };
        });
        expect(cold.cacheResult).toBe("miss");
        expect(warm.cacheResult).toBe("hit");
        expect(computeCalls).toBe(1);
        const row = await adapter.getNodeDiffCache(key.runId, key.nodeId, key.iteration, key.baseRef);
        expect(row).toBeDefined();
        expect(row?.diffJson).toBe(JSON.stringify(BUNDLE));
        sqlite.close();
    });
    test("single-flight computes once for concurrent callers", async () => {
        const { sqlite, adapter } = createDb();
        const cache = new NodeDiffCache(adapter);
        let computeCalls = 0;
        const key = {
            runId: "run-node-diff-flight",
            nodeId: "task:diff",
            iteration: 0,
            baseRef: "base-2",
        };
        const all = await Promise.all(Array.from({ length: 10 }, () => cache.getOrCompute(key, async () => {
            computeCalls += 1;
            await Bun.sleep(25);
            return {
                ...BUNDLE,
                seq: 7,
            };
        })));
        expect(computeCalls).toBe(1);
        expect(all.every((entry) => entry.bundle.seq === 7)).toBe(true);
        const rows = await cache.countRows(key.runId);
        expect(rows).toBe(1);
        sqlite.close();
    });
    test("cache write failure still returns computed result and logs warn", async () => {
        const warnings = [];
        const cache = new NodeDiffCache({
            getNodeDiffCache: async () => null,
            upsertNodeDiffCache: async () => {
                throw new Error("db write failed");
            },
            invalidateNodeDiffsAfterFrame: async () => 0,
            countNodeDiffCacheRows: async () => 0,
        }, {
            warn: (message, details) => {
                warnings.push({ message, details });
            },
        });
        const result = await cache.getOrCompute({
            runId: "run-node-diff-warn",
            nodeId: "task:warn",
            iteration: 0,
            baseRef: "base-3",
        }, async () => ({ ...BUNDLE, seq: 9 }));
        expect(result.bundle.seq).toBe(9);
        expect(result.cacheResult).toBe("miss");
        expect(warnings.length).toBe(1);
        expect(warnings[0]?.message).toContain("Failed writing node diff cache row");
    });
    test("cached row missing optional columns is handled gracefully", async () => {
        let computeCalls = 0;
        const cache = new NodeDiffCache({
            getNodeDiffCache: async () => ({
                runId: "r1",
                nodeId: "n1",
                iteration: 0,
                baseRef: "base-4",
                diffJson: JSON.stringify({ ...BUNDLE, seq: 11 }),
            }),
            upsertNodeDiffCache: async () => undefined,
            invalidateNodeDiffsAfterFrame: async () => 0,
            countNodeDiffCacheRows: async () => 1,
        });
        const result = await cache.getOrCompute({
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            baseRef: "base-4",
        }, async () => {
            computeCalls += 1;
            return { ...BUNDLE, seq: 12 };
        });
        expect(result.cacheResult).toBe("hit");
        expect(result.bundle.seq).toBe(11);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(computeCalls).toBe(0);
    });
    test("cached lookup is fast enough to satisfy p95 budget", async () => {
        const { sqlite, adapter } = createDb();
        const cache = new NodeDiffCache(adapter);
        const key = {
            runId: "run-node-diff-perf",
            nodeId: "task:perf",
            iteration: 0,
            baseRef: "base-perf",
        };
        await cache.getOrCompute(key, async () => BUNDLE);
        const iterations = 50;
        const samples = [];
        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            const warm = await cache.getOrCompute(key, async () => {
                throw new Error("compute must not run for cached call");
            });
            samples.push(performance.now() - start);
            expect(warm.cacheResult).toBe("hit");
        }
        samples.sort((a, b) => a - b);
        const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
        expect(p95).toBeLessThan(50);
        sqlite.close();
    });
    test("invalidation after frame truncation removes only affected rows", async () => {
        const { sqlite, adapter } = createDb();
        const cache = new NodeDiffCache(adapter);
        const runId = "run-node-diff-invalidate";
        await adapter.insertFrame({
            runId,
            frameNo: 0,
            createdAtMs: 1_000,
            xmlJson: "<Workflow/>",
            xmlHash: "f0",
            encoding: "keyframe",
            mountedTaskIdsJson: null,
            taskIndexJson: null,
            note: null,
        });
        await adapter.insertAttempt({
            runId,
            nodeId: "keep",
            iteration: 0,
            attempt: 1,
            state: "finished",
            startedAtMs: 900,
            finishedAtMs: 950,
            heartbeatAtMs: null,
            heartbeatDataJson: null,
            errorJson: null,
            jjPointer: "ptr-keep",
            responseText: null,
            jjCwd: "/tmp/repo",
            cached: false,
            metaJson: null,
        });
        await adapter.insertAttempt({
            runId,
            nodeId: "drop",
            iteration: 0,
            attempt: 1,
            state: "finished",
            startedAtMs: 1_100,
            finishedAtMs: 1_150,
            heartbeatAtMs: null,
            heartbeatDataJson: null,
            errorJson: null,
            jjPointer: "ptr-drop",
            responseText: null,
            jjCwd: "/tmp/repo",
            cached: false,
            metaJson: null,
        });
        await adapter.upsertNodeDiffCache({
            runId,
            nodeId: "keep",
            iteration: 0,
            baseRef: "base-k",
            diffJson: JSON.stringify(BUNDLE),
            computedAtMs: Date.now(),
            sizeBytes: 42,
        });
        await adapter.upsertNodeDiffCache({
            runId,
            nodeId: "drop",
            iteration: 0,
            baseRef: "base-d",
            diffJson: JSON.stringify(BUNDLE),
            computedAtMs: Date.now(),
            sizeBytes: 42,
        });
        const deleted = await cache.invalidateAfterFrame(runId, 0);
        expect(deleted).toBe(1);
        const keep = await adapter.getNodeDiffCache(runId, "keep", 0, "base-k");
        const drop = await adapter.getNodeDiffCache(runId, "drop", 0, "base-d");
        expect(keep).toBeDefined();
        expect(drop).toBeUndefined();
        sqlite.close();
    });
});
