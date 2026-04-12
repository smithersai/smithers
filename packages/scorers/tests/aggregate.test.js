import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { SmithersDb } from "@smithers/db/adapter";
import { aggregateScores } from "../src/aggregate.js";
import crypto from "node:crypto";
describe("aggregateScores", () => {
    let db;
    let adapter;
    beforeEach(() => {
        const sqlite = new Database(":memory:");
        db = drizzle(sqlite);
        ensureSmithersTables(db);
        adapter = new SmithersDb(db);
    });
    /**
   * @param {Partial<{ id: string; runId: string; nodeId: string; iteration: number; attempt: number; scorerId: string; scorerName: string; source: string; score: number; reason: string | null; metaJson: string | null; inputJson: string | null; outputJson: string | null; latencyMs: number | null; scoredAtMs: number; durationMs: number | null; }>} [overrides]
   */
    async function insertScore(overrides = {}) {
        const row = {
            id: overrides.id ?? crypto.randomUUID(),
            runId: overrides.runId ?? "run-1",
            nodeId: overrides.nodeId ?? "task-1",
            iteration: overrides.iteration ?? 0,
            attempt: overrides.attempt ?? 1,
            scorerId: overrides.scorerId ?? "test-scorer",
            scorerName: overrides.scorerName ?? "Test Scorer",
            source: overrides.source ?? "batch",
            score: overrides.score ?? 0.8,
            reason: overrides.reason ?? null,
            metaJson: overrides.metaJson ?? null,
            inputJson: overrides.inputJson ?? null,
            outputJson: overrides.outputJson ?? null,
            latencyMs: overrides.latencyMs ?? null,
            scoredAtMs: overrides.scoredAtMs ?? Date.now(),
            durationMs: overrides.durationMs ?? null,
        };
        await adapter.insertScorerResult(row);
        return row;
    }
    it("returns empty array when no scores exist", async () => {
        const result = await aggregateScores(adapter);
        expect(result).toEqual([]);
    });
    it("aggregates basic statistics for a single scorer", async () => {
        await insertScore({ score: 0.6 });
        await insertScore({ score: 0.8 });
        await insertScore({ score: 1.0 });
        const result = await aggregateScores(adapter);
        expect(result).toHaveLength(1);
        expect(result[0].scorerId).toBe("test-scorer");
        expect(result[0].count).toBe(3);
        expect(result[0].mean).toBeCloseTo(0.8, 1);
        expect(result[0].min).toBeCloseTo(0.6, 1);
        expect(result[0].max).toBeCloseTo(1.0, 1);
    });
    it("aggregates multiple scorers independently", async () => {
        await insertScore({ scorerId: "scorer-a", scorerName: "Scorer A", score: 0.9 });
        await insertScore({ scorerId: "scorer-a", scorerName: "Scorer A", score: 0.7 });
        await insertScore({ scorerId: "scorer-b", scorerName: "Scorer B", score: 0.5 });
        const result = await aggregateScores(adapter);
        expect(result).toHaveLength(2);
        const a = result.find((r) => r.scorerId === "scorer-a");
        const b = result.find((r) => r.scorerId === "scorer-b");
        expect(a?.count).toBe(2);
        expect(a?.mean).toBeCloseTo(0.8, 1);
        expect(b?.count).toBe(1);
        expect(b?.mean).toBeCloseTo(0.5, 1);
    });
    it("filters by runId", async () => {
        await insertScore({ runId: "run-1", scorerId: "s", scorerName: "S", score: 0.9 });
        await insertScore({ runId: "run-2", scorerId: "s", scorerName: "S", score: 0.1 });
        const result = await aggregateScores(adapter, { runId: "run-1" });
        expect(result).toHaveLength(1);
        expect(result[0].mean).toBeCloseTo(0.9, 1);
    });
    it("filters by nodeId", async () => {
        await insertScore({ nodeId: "task-a", scorerId: "s", scorerName: "S", score: 1.0 });
        await insertScore({ nodeId: "task-b", scorerId: "s", scorerName: "S", score: 0.0 });
        const result = await aggregateScores(adapter, { nodeId: "task-a" });
        expect(result).toHaveLength(1);
        expect(result[0].mean).toBeCloseTo(1.0, 1);
    });
    it("filters by scorerId", async () => {
        await insertScore({ scorerId: "latency", scorerName: "Latency", score: 0.7 });
        await insertScore({ scorerId: "schema", scorerName: "Schema", score: 1.0 });
        const result = await aggregateScores(adapter, { scorerId: "latency" });
        expect(result).toHaveLength(1);
        expect(result[0].scorerName).toBe("Latency");
    });
    it("computes p50 (median) correctly", async () => {
        // Insert 5 scores: 0.1, 0.3, 0.5, 0.7, 0.9
        await insertScore({ score: 0.1 });
        await insertScore({ score: 0.3 });
        await insertScore({ score: 0.5 });
        await insertScore({ score: 0.7 });
        await insertScore({ score: 0.9 });
        const result = await aggregateScores(adapter);
        expect(result).toHaveLength(1);
        // Median of [0.1, 0.3, 0.5, 0.7, 0.9] is 0.5
        expect(result[0].p50).toBeCloseTo(0.5, 1);
    });
});
