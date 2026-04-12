import { describe, expect, test } from "bun:test";
// We'll test the aggregate module's escapeSql through the public API
// and validate AggregateScore type expectations
describe("scorers aggregate", () => {
    // Test escapeSql through a targeted import
    // Since escapeSql is not exported, we test it indirectly via aggregateScores
    // but we can also verify the module exports correctly
    test("aggregateScores is exported", async () => {
        const mod = await import("../src/aggregate.js");
        expect(typeof mod.aggregateScores).toBe("function");
    });
    test("AggregateOptions type allows optional filters", async () => {
        const mod = await import("../src/aggregate.js");
        // Verify the function accepts an adapter and optional options
        expect(mod.aggregateScores.length).toBeGreaterThanOrEqual(1);
    });
});
// We can test the SQL escaping by examining the behavior through a mock adapter
describe("aggregateScores with mock adapter", () => {
    test("returns empty array when no scores exist", async () => {
        const { aggregateScores } = await import("../src/aggregate.js");
        const capturedQueries = [];
        const mockAdapter = {
            rawQuery: async (sql) => {
                capturedQueries.push(sql);
                return [];
            },
        };
        const result = await aggregateScores(mockAdapter);
        expect(result).toEqual([]);
        // First query is the aggregation query
        expect(capturedQueries.length).toBeGreaterThanOrEqual(1);
        expect(capturedQueries[0]).toContain("_smithers_scorers");
    });
    test("applies runId filter", async () => {
        const { aggregateScores } = await import("../src/aggregate.js");
        const capturedQueries = [];
        const mockAdapter = {
            rawQuery: async (sql) => {
                capturedQueries.push(sql);
                return [];
            },
        };
        await aggregateScores(mockAdapter, { runId: "run-123" });
        expect(capturedQueries[0]).toContain("run_id = 'run-123'");
    });
    test("applies nodeId filter", async () => {
        const { aggregateScores } = await import("../src/aggregate.js");
        const capturedQueries = [];
        const mockAdapter = {
            rawQuery: async (sql) => {
                capturedQueries.push(sql);
                return [];
            },
        };
        await aggregateScores(mockAdapter, { nodeId: "node-1" });
        expect(capturedQueries[0]).toContain("node_id = 'node-1'");
    });
    test("applies scorerId filter", async () => {
        const { aggregateScores } = await import("../src/aggregate.js");
        const capturedQueries = [];
        const mockAdapter = {
            rawQuery: async (sql) => {
                capturedQueries.push(sql);
                return [];
            },
        };
        await aggregateScores(mockAdapter, { scorerId: "relevancy" });
        expect(capturedQueries[0]).toContain("scorer_id = 'relevancy'");
    });
    test("combines multiple filters with AND", async () => {
        const { aggregateScores } = await import("../src/aggregate.js");
        const capturedQueries = [];
        const mockAdapter = {
            rawQuery: async (sql) => {
                capturedQueries.push(sql);
                return [];
            },
        };
        await aggregateScores(mockAdapter, { runId: "r", nodeId: "n" });
        expect(capturedQueries[0]).toContain("AND");
    });
    test("escapes single quotes in filter values", async () => {
        const { aggregateScores } = await import("../src/aggregate.js");
        const capturedQueries = [];
        const mockAdapter = {
            rawQuery: async (sql) => {
                capturedQueries.push(sql);
                return [];
            },
        };
        await aggregateScores(mockAdapter, { runId: "it's a test" });
        expect(capturedQueries[0]).toContain("it''s a test");
    });
    test("maps result rows correctly", async () => {
        const { aggregateScores } = await import("../src/aggregate.js");
        let callCount = 0;
        const mockAdapter = {
            rawQuery: async () => {
                callCount++;
                if (callCount === 1) {
                    // Aggregation query
                    return [
                        {
                            scorer_id: "test",
                            scorer_name: "Test",
                            cnt: "5",
                            mean: "0.7",
                            min_score: "0.2",
                            max_score: "1.0",
                        },
                    ];
                }
                // Scores query for p50/stddev
                return [
                    { scorer_id: "test", score: 0.2 },
                    { scorer_id: "test", score: 0.5 },
                    { scorer_id: "test", score: 0.8 },
                    { scorer_id: "test", score: 0.9 },
                    { scorer_id: "test", score: 1.0 },
                ];
            },
        };
        const result = await aggregateScores(mockAdapter);
        expect(result).toHaveLength(1);
        expect(result[0].scorerId).toBe("test");
        expect(result[0].count).toBe(5);
        expect(result[0].mean).toBe(0.7);
        expect(result[0].min).toBe(0.2);
        expect(result[0].max).toBe(1);
        expect(result[0].p50).toBe(0.8);
    });
    test("handles snake_case column names", async () => {
        const { aggregateScores } = await import("../src/aggregate.js");
        let callCount = 0;
        const mockAdapter = {
            rawQuery: async () => {
                callCount++;
                if (callCount === 1) {
                    return [
                        {
                            scorer_id: "test",
                            scorer_name: "Test",
                            cnt: 3,
                            mean: 0.5,
                            min_score: 0.1,
                            max_score: 0.9,
                        },
                    ];
                }
                return [
                    { scorer_id: "test", score: 0.1 },
                    { scorer_id: "test", score: 0.5 },
                    { scorer_id: "test", score: 0.9 },
                ];
            },
        };
        const result = await aggregateScores(mockAdapter);
        expect(result[0].scorerId).toBe("test");
        expect(result[0].scorerName).toBe("Test");
    });
    test("defaults null values to 0", async () => {
        const { aggregateScores } = await import("../src/aggregate.js");
        let callCount = 0;
        const mockAdapter = {
            rawQuery: async () => {
                callCount++;
                if (callCount === 1) {
                    return [
                        {
                            scorer_id: "test",
                            scorer_name: "Test",
                            cnt: 1,
                            mean: null,
                            min_score: null,
                            max_score: null,
                        },
                    ];
                }
                return [];
            },
        };
        const result = await aggregateScores(mockAdapter);
        expect(result[0].mean).toBe(0);
        expect(result[0].min).toBe(0);
        expect(result[0].max).toBe(0);
        expect(result[0].p50).toBe(0);
        expect(result[0].stddev).toBe(0);
    });
});
