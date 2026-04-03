import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { loadInput, loadOutputs } from "../src/db/snapshot";

const testInput = sqliteTable("test_input", {
  runId: text("run_id").notNull(),
  prompt: text("prompt"),
});

const testOutput = sqliteTable("test_output", {
  runId: text("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  iteration: integer("iteration").notNull().default(0),
  result: text("result"),
});

function createTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-snap-"));
  const path = join(dir, "db.sqlite");
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE test_input (
      run_id TEXT NOT NULL,
      prompt TEXT
    );
    CREATE TABLE test_output (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      result TEXT
    );
  `);
  const db = drizzle(sqlite, {
    schema: { input: testInput, output: testOutput },
  });
  return { db, sqlite, cleanup: () => sqlite.close() };
}

describe("loadInput", () => {
  test("loads input row by runId", async () => {
    const { db, sqlite, cleanup } = createTestDb();
    try {
      sqlite.exec(`INSERT INTO test_input (run_id, prompt) VALUES ('run-1', 'Hello world')`);
      const result = await loadInput(db, testInput, "run-1");
      expect(result).toBeDefined();
      expect(result.prompt).toBe("Hello world");
    } finally {
      cleanup();
    }
  });

  test("returns undefined for missing runId", async () => {
    const { db, cleanup } = createTestDb();
    try {
      const result = await loadInput(db, testInput, "nonexistent");
      expect(result).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("returns first row when multiple exist", async () => {
    const { db, sqlite, cleanup } = createTestDb();
    try {
      sqlite.exec(`INSERT INTO test_input (run_id, prompt) VALUES ('run-1', 'First')`);
      sqlite.exec(`INSERT INTO test_input (run_id, prompt) VALUES ('run-1', 'Second')`);
      const result = await loadInput(db, testInput, "run-1");
      expect(result.prompt).toBe("First");
    } finally {
      cleanup();
    }
  });
});

describe("loadOutputs", () => {
  test("loads output rows by runId", async () => {
    const { db, sqlite, cleanup } = createTestDb();
    try {
      sqlite.exec(`INSERT INTO test_output (run_id, node_id, iteration, result) VALUES ('run-1', 'node-a', 0, 'ok')`);
      const result = await loadOutputs(
        db,
        { output: testOutput },
        "run-1",
      );
      expect(result.test_output).toBeDefined();
      expect(result.test_output).toHaveLength(1);
      expect(result.test_output[0].result).toBe("ok");
    } finally {
      cleanup();
    }
  });

  test("returns empty object when no outputs", async () => {
    const { db, cleanup } = createTestDb();
    try {
      const result = await loadOutputs(
        db,
        { output: testOutput },
        "nonexistent",
      );
      // Table key should exist but be empty
      expect(result.test_output).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("skips input table in schema", async () => {
    const { db, sqlite, cleanup } = createTestDb();
    try {
      sqlite.exec(`INSERT INTO test_input (run_id, prompt) VALUES ('run-1', 'input')`);
      sqlite.exec(`INSERT INTO test_output (run_id, node_id, iteration, result) VALUES ('run-1', 'n', 0, 'output')`);
      const result = await loadOutputs(
        db,
        { input: testInput, output: testOutput },
        "run-1",
      );
      // input should be skipped
      expect(result.test_input).toBeUndefined();
      expect(result.test_output).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("maps both table name and key name", async () => {
    const { db, sqlite, cleanup } = createTestDb();
    try {
      sqlite.exec(`INSERT INTO test_output (run_id, node_id, iteration, result) VALUES ('run-1', 'n', 0, 'value')`);
      const result = await loadOutputs(
        db,
        { myKey: testOutput },
        "run-1",
      );
      // Both the Drizzle table name and the schema key should work
      expect(result.test_output).toHaveLength(1);
      expect(result.myKey).toHaveLength(1);
      expect(result.test_output[0]).toEqual(result.myKey[0]);
    } finally {
      cleanup();
    }
  });
});
