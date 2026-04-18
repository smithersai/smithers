import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { captureSnapshot, loadSnapshot, loadLatestSnapshot, listSnapshots, parseSnapshot, } from "../src/snapshot/index.js";
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), db, sqlite };
}
/**
 * @param {Partial<SnapshotData>} [overrides]
 * @returns {SnapshotData}
 */
function sampleData(overrides = {}) {
    return {
        nodes: [
            { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
            { nodeId: "implement", iteration: 0, state: "pending", lastAttempt: null, outputTable: "out_implement", label: null },
        ],
        outputs: { out_analyze: [{ text: "analysis result" }] },
        ralph: [{ ralphId: "main-loop", iteration: 0, done: false }],
        input: { prompt: "Build something" },
        ...overrides,
    };
}
describe("captureSnapshot", () => {
    test("inserts and returns a snapshot row", async () => {
        const { adapter } = createTestDb();
        const snap = await captureSnapshot(adapter, "run-1", 0, sampleData());
        expect(snap.runId).toBe("run-1");
        expect(snap.frameNo).toBe(0);
        expect(snap.contentHash).toBeTruthy();
        expect(typeof snap.createdAtMs).toBe("number");
    });
    test("upserts on conflict", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        const snap2 = await captureSnapshot(adapter, "run-1", 0, sampleData({ input: { prompt: "different" } }));
        expect(snap2.runId).toBe("run-1");
        expect(snap2.frameNo).toBe(0);
        expect(JSON.parse(snap2.inputJson).prompt).toBe("different");
    });
    test("captures multiple frames", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData({
            nodes: [
                { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
                { nodeId: "implement", iteration: 0, state: "running", lastAttempt: 1, outputTable: "out_implement", label: null },
            ],
        }));
        const list = await listSnapshots(adapter, "run-1");
        expect(list.length).toBe(2);
        expect(list[0].frameNo).toBe(0);
        expect(list[1].frameNo).toBe(1);
    });
});
describe("loadSnapshot", () => {
    test("returns undefined for missing snapshot", async () => {
        const { adapter } = createTestDb();
        const result = await loadSnapshot(adapter, "nonexistent", 0);
        expect(result).toBeUndefined();
    });
    test("returns the correct snapshot", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData());
        const snap = await loadSnapshot(adapter, "run-1", 1);
        expect(snap).toBeDefined();
        expect(snap.frameNo).toBe(1);
    });
});
describe("loadLatestSnapshot", () => {
    test("returns the highest frame_no snapshot", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData());
        await captureSnapshot(adapter, "run-1", 2, sampleData());
        const snap = await loadLatestSnapshot(adapter, "run-1");
        expect(snap).toBeDefined();
        expect(snap.frameNo).toBe(2);
    });
    test("returns undefined for run with no snapshots", async () => {
        const { adapter } = createTestDb();
        const result = await loadLatestSnapshot(adapter, "nonexistent");
        expect(result).toBeUndefined();
    });
});
describe("listSnapshots", () => {
    test("returns empty array for unknown run", async () => {
        const { adapter } = createTestDb();
        const list = await listSnapshots(adapter, "nope");
        expect(list).toEqual([]);
    });
    test("returns summary fields ordered by frame_no", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 2, sampleData());
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData());
        const list = await listSnapshots(adapter, "run-1");
        expect(list.length).toBe(3);
        expect(list[0].frameNo).toBe(0);
        expect(list[1].frameNo).toBe(1);
        expect(list[2].frameNo).toBe(2);
        // Verify summary fields only
        expect(list[0]).toHaveProperty("contentHash");
        expect(list[0]).toHaveProperty("createdAtMs");
    });
});
describe("parseSnapshot", () => {
    test("parses JSON blobs into structured data", async () => {
        const { adapter } = createTestDb();
        const snap = await captureSnapshot(adapter, "run-1", 0, sampleData());
        const parsed = parseSnapshot(snap);
        expect(parsed.runId).toBe("run-1");
        expect(parsed.frameNo).toBe(0);
        expect(Object.keys(parsed.nodes).length).toBe(2);
        expect(parsed.nodes["analyze::0"].state).toBe("finished");
        expect(parsed.nodes["implement::0"].state).toBe("pending");
        expect(parsed.input).toEqual({ prompt: "Build something" });
        expect(Object.keys(parsed.ralph).length).toBe(1);
        expect(parsed.ralph["main-loop"].done).toBe(false);
    });
});
