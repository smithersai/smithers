import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import { smithersScorers } from "../src/schema.js";
describe("smithersScorers schema", () => {
    test("table can be created and queried", () => {
        const sqlite = new Database(":memory:");
        sqlite.run(`
      CREATE TABLE "_smithers_scorers" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "node_id" TEXT NOT NULL,
        "iteration" INTEGER NOT NULL DEFAULT 0,
        "attempt" INTEGER NOT NULL DEFAULT 0,
        "scorer_id" TEXT NOT NULL,
        "scorer_name" TEXT NOT NULL,
        "source" TEXT NOT NULL,
        "score" REAL NOT NULL,
        "reason" TEXT,
        "meta_json" TEXT,
        "input_json" TEXT,
        "output_json" TEXT,
        "latency_ms" REAL,
        "scored_at_ms" INTEGER NOT NULL,
        "duration_ms" REAL
      )
    `);
        const db = drizzle(sqlite, { schema: { smithersScorers } });
        // Insert a row
        db.insert(smithersScorers)
            .values({
            id: "score-1",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 0,
            attempt: 0,
            scorerId: "accuracy",
            scorerName: "Accuracy Scorer",
            source: "live",
            score: 0.95,
            reason: "High quality output",
            metaJson: JSON.stringify({ model: "claude" }),
            inputJson: JSON.stringify({ prompt: "test" }),
            outputJson: JSON.stringify({ result: "ok" }),
            latencyMs: 123.45,
            scoredAtMs: Date.now(),
            durationMs: 50.2,
        })
            .run();
        // Query the row back
        const rows = db.select().from(smithersScorers).all();
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe("score-1");
        expect(rows[0].runId).toBe("run-1");
        expect(rows[0].nodeId).toBe("node-1");
        expect(rows[0].score).toBe(0.95);
        expect(rows[0].scorerName).toBe("Accuracy Scorer");
        expect(rows[0].source).toBe("live");
        expect(rows[0].reason).toBe("High quality output");
        expect(rows[0].latencyMs).toBe(123.45);
        sqlite.close();
    });
    test("enforces NOT NULL constraints", () => {
        const sqlite = new Database(":memory:");
        sqlite.run(`
      CREATE TABLE "_smithers_scorers" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "node_id" TEXT NOT NULL,
        "iteration" INTEGER NOT NULL DEFAULT 0,
        "attempt" INTEGER NOT NULL DEFAULT 0,
        "scorer_id" TEXT NOT NULL,
        "scorer_name" TEXT NOT NULL,
        "source" TEXT NOT NULL,
        "score" REAL NOT NULL,
        "reason" TEXT,
        "meta_json" TEXT,
        "input_json" TEXT,
        "output_json" TEXT,
        "latency_ms" REAL,
        "scored_at_ms" INTEGER NOT NULL,
        "duration_ms" REAL
      )
    `);
        // Attempt to insert without required fields should fail
        expect(() => {
            sqlite.run(`INSERT INTO "_smithers_scorers" (id) VALUES ('bad')`);
        }).toThrow();
        sqlite.close();
    });
    test("nullable columns accept null", () => {
        const sqlite = new Database(":memory:");
        sqlite.run(`
      CREATE TABLE "_smithers_scorers" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "node_id" TEXT NOT NULL,
        "iteration" INTEGER NOT NULL DEFAULT 0,
        "attempt" INTEGER NOT NULL DEFAULT 0,
        "scorer_id" TEXT NOT NULL,
        "scorer_name" TEXT NOT NULL,
        "source" TEXT NOT NULL,
        "score" REAL NOT NULL,
        "reason" TEXT,
        "meta_json" TEXT,
        "input_json" TEXT,
        "output_json" TEXT,
        "latency_ms" REAL,
        "scored_at_ms" INTEGER NOT NULL,
        "duration_ms" REAL
      )
    `);
        const db = drizzle(sqlite, { schema: { smithersScorers } });
        db.insert(smithersScorers)
            .values({
            id: "score-2",
            runId: "run-1",
            nodeId: "node-1",
            scorerId: "test",
            scorerName: "Test",
            source: "batch",
            score: 0.5,
            reason: null,
            metaJson: null,
            inputJson: null,
            outputJson: null,
            latencyMs: null,
            scoredAtMs: Date.now(),
            durationMs: null,
        })
            .run();
        const rows = db.select().from(smithersScorers).all();
        expect(rows).toHaveLength(1);
        expect(rows[0].reason).toBeNull();
        expect(rows[0].metaJson).toBeNull();
        expect(rows[0].latencyMs).toBeNull();
        expect(rows[0].durationMs).toBeNull();
        sqlite.close();
    });
    test("defaults iteration and attempt to 0", () => {
        const sqlite = new Database(":memory:");
        sqlite.run(`
      CREATE TABLE "_smithers_scorers" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "node_id" TEXT NOT NULL,
        "iteration" INTEGER NOT NULL DEFAULT 0,
        "attempt" INTEGER NOT NULL DEFAULT 0,
        "scorer_id" TEXT NOT NULL,
        "scorer_name" TEXT NOT NULL,
        "source" TEXT NOT NULL,
        "score" REAL NOT NULL,
        "reason" TEXT,
        "meta_json" TEXT,
        "input_json" TEXT,
        "output_json" TEXT,
        "latency_ms" REAL,
        "scored_at_ms" INTEGER NOT NULL,
        "duration_ms" REAL
      )
    `);
        // Insert without specifying iteration/attempt
        sqlite.run(`
      INSERT INTO "_smithers_scorers" (id, run_id, node_id, scorer_id, scorer_name, source, score, scored_at_ms)
      VALUES ('s1', 'r1', 'n1', 'sid', 'sname', 'live', 0.8, 1000)
    `);
        const row = sqlite.query('SELECT * FROM "_smithers_scorers" WHERE id = ?').get("s1");
        expect(row.iteration).toBe(0);
        expect(row.attempt).toBe(0);
        sqlite.close();
    });
});
