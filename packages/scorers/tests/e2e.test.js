import { describe, expect, it, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { SmithersDb } from "@smithers/db/adapter";
import { createScorer } from "../src/create-scorer.js";
import { schemaAdherenceScorer, latencyScorer } from "../src/builtins.js";
import { runScorersBatch } from "../src/run-scorers.js";
import { aggregateScores } from "../src/aggregate.js";
import { z } from "zod";
describe("scorers e2e", () => {
    let db;
    let adapter;
    beforeEach(() => {
        const sqlite = new Database(":memory:");
        db = drizzle(sqlite);
        ensureSmithersTables(db);
        adapter = new SmithersDb(db);
    });
    it("full lifecycle: attach scorers, run batch, persist, aggregate", async () => {
        const outputSchema = z.object({
            summary: z.string(),
            severity: z.enum(["low", "medium", "high"]),
        });
        // Define scorers
        const scorers = {
            schema: { scorer: schemaAdherenceScorer() },
            latency: { scorer: latencyScorer({ targetMs: 5000, maxMs: 30000 }) },
            custom: {
                scorer: createScorer({
                    id: "word-count",
                    name: "Word Count",
                    description: "Checks word count",
                    score: async ({ output }) => {
                        const text = JSON.stringify(output);
                        const words = text.split(/\s+/).length;
                        return {
                            score: Math.min(words / 10, 1),
                            reason: `${words} words`,
                        };
                    },
                }),
            },
        };
        // Simulate task context
        const ctx = {
            runId: "e2e-run-1",
            nodeId: "analyze",
            iteration: 0,
            attempt: 1,
            input: "Analyze the codebase",
            output: { summary: "Code looks clean and well-structured", severity: "low" },
            latencyMs: 8000,
            outputSchema,
        };
        // Run scorers in batch mode (blocking, persists to DB)
        const results = await runScorersBatch(scorers, ctx, adapter);
        // Verify results
        expect(results.schema?.score).toBe(1);
        expect(results.schema?.reason).toBe("Output matches schema");
        expect(results.latency?.score).toBeGreaterThan(0);
        expect(results.latency?.score).toBeLessThan(1);
        expect(results.custom?.score).toBeGreaterThan(0);
        expect(results.custom?.reason).toContain("words");
        // Verify persistence
        const storedScores = await adapter.listScorerResults("e2e-run-1");
        expect(storedScores).toHaveLength(3);
        // Verify aggregation
        const aggregated = await aggregateScores(adapter, { runId: "e2e-run-1" });
        expect(aggregated.length).toBeGreaterThanOrEqual(1);
        // Each scorer should appear in aggregation
        const scorerIds = aggregated.map((a) => a.scorerId);
        expect(scorerIds).toContain("schema-adherence");
        expect(scorerIds).toContain("latency");
        expect(scorerIds).toContain("word-count");
    });
    it("handles schema validation failure correctly", async () => {
        const outputSchema = z.object({
            name: z.string(),
            age: z.number(),
        });
        const scorers = {
            schema: { scorer: schemaAdherenceScorer() },
        };
        const ctx = {
            runId: "e2e-run-2",
            nodeId: "validate",
            iteration: 0,
            attempt: 1,
            input: "Extract user info",
            output: { name: 123, age: "not-a-number" }, // Invalid
            outputSchema,
        };
        const results = await runScorersBatch(scorers, ctx, adapter);
        expect(results.schema?.score).toBe(0);
        expect(results.schema?.reason).toContain("Schema validation failed");
    });
    it("supports multiple runs with independent aggregation", async () => {
        const scorer = createScorer({
            id: "quality",
            name: "Quality",
            description: "d",
            score: async ({ output }) => ({
                score: typeof output === "object" ? 0.9 : 0.1,
            }),
        });
        const scorers = { quality: { scorer } };
        // Run 1
        await runScorersBatch(scorers, {
            runId: "multi-run-1",
            nodeId: "task",
            iteration: 0,
            attempt: 1,
            input: "test",
            output: { data: "structured" },
        }, adapter);
        // Run 2
        await runScorersBatch(scorers, {
            runId: "multi-run-2",
            nodeId: "task",
            iteration: 0,
            attempt: 1,
            input: "test",
            output: "plain string",
        }, adapter);
        const run1Agg = await aggregateScores(adapter, { runId: "multi-run-1" });
        const run2Agg = await aggregateScores(adapter, { runId: "multi-run-2" });
        expect(run1Agg[0]?.mean).toBeCloseTo(0.9, 1);
        expect(run2Agg[0]?.mean).toBeCloseTo(0.1, 1);
    });
    it("sampling: none skips scoring entirely", async () => {
        const scoreFn = mock(async () => ({ score: 1 }));
        const scorers = {
            disabled: {
                scorer: createScorer({
                    id: "disabled",
                    name: "Disabled",
                    description: "d",
                    score: scoreFn,
                }),
                sampling: { type: "none" },
            },
        };
        const results = await runScorersBatch(scorers, {
            runId: "sampling-run",
            nodeId: "task",
            iteration: 0,
            attempt: 1,
            input: "test",
            output: "out",
        }, adapter);
        expect(results.disabled).toBeNull();
        expect(scoreFn).not.toHaveBeenCalled();
        // Nothing should be persisted
        const stored = await adapter.listScorerResults("sampling-run");
        expect(stored).toHaveLength(0);
    });
    it("listScorerResults filters by nodeId", async () => {
        const scorer = createScorer({
            id: "filter-test",
            name: "Filter",
            description: "d",
            score: async () => ({ score: 0.5 }),
        });
        const scorers = { filter: { scorer } };
        await runScorersBatch(scorers, {
            runId: "filter-run",
            nodeId: "task-a",
            iteration: 0,
            attempt: 1,
            input: "a",
            output: "a",
        }, adapter);
        await runScorersBatch(scorers, {
            runId: "filter-run",
            nodeId: "task-b",
            iteration: 0,
            attempt: 1,
            input: "b",
            output: "b",
        }, adapter);
        const all = await adapter.listScorerResults("filter-run");
        expect(all).toHaveLength(2);
        const nodeA = await adapter.listScorerResults("filter-run", "task-a");
        expect(nodeA).toHaveLength(1);
        const nodeB = await adapter.listScorerResults("filter-run", "task-b");
        expect(nodeB).toHaveLength(1);
    });
});
