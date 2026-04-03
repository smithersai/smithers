import { describe, expect, test } from "bun:test";
import { loadInput, loadOutputs } from "../src/db/snapshot";
import { zodToTable } from "../src/zodToTable";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

describe("loadInput", () => {
  test("loads input row by runId", async () => {
    const inputTable = sqliteTable("input", {
      runId: text("run_id").primaryKey(),
      payload: text("payload"),
    });
    const sqlite = new Database(":memory:");
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS input (run_id TEXT PRIMARY KEY, payload TEXT)`,
    );
    const db = drizzle(sqlite, { schema: { input: inputTable } });
    db.insert(inputTable)
      .values({ runId: "r1", payload: '{"topic":"ai"}' })
      .run();

    const result = await loadInput(db, inputTable, "r1");
    expect(result).toBeDefined();
    expect(result.runId).toBe("r1");
    expect(result.payload).toBe('{"topic":"ai"}');
    sqlite.close();
  });

  test("returns undefined for missing runId", async () => {
    const inputTable = sqliteTable("input", {
      runId: text("run_id").primaryKey(),
      payload: text("payload"),
    });
    const sqlite = new Database(":memory:");
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS input (run_id TEXT PRIMARY KEY, payload TEXT)`,
    );
    const db = drizzle(sqlite, { schema: { input: inputTable } });
    const result = await loadInput(db, inputTable, "missing");
    expect(result).toBeUndefined();
    sqlite.close();
  });
});

describe("loadOutputs", () => {
  test("loads all output tables for a run", async () => {
    const schema = z.object({ value: z.number() });
    const table = zodToTable("output_a", schema);
    const sqlite = new Database(":memory:");
    sqlite.exec(zodToCreateTableSQL("output_a", schema));
    const db = drizzle(sqlite, { schema: { outputA: table } });

    db.insert(table)
      .values({ runId: "r1", nodeId: "n1", iteration: 0, value: 42 })
      .run();

    const outputs = await loadOutputs(db, { outputA: table }, "r1");
    // Should have rows indexed by both the key name and table name
    expect(outputs.outputA).toBeDefined();
    expect(outputs.outputA.length).toBe(1);
    expect(outputs.outputA[0].value).toBe(42);
    sqlite.close();
  });

  test("skips input key", async () => {
    const schema = z.object({ value: z.number() });
    const table = zodToTable("output_a", schema);
    const sqlite = new Database(":memory:");
    sqlite.exec(zodToCreateTableSQL("output_a", schema));
    const inputTable = sqliteTable("input", {
      runId: text("run_id").primaryKey(),
    });
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS input (run_id TEXT PRIMARY KEY)`,
    );
    const db = drizzle(sqlite, { schema: { input: inputTable, outputA: table } });

    const outputs = await loadOutputs(
      db,
      { input: inputTable, outputA: table },
      "r1",
    );
    expect(outputs).not.toHaveProperty("input");
    sqlite.close();
  });

  test("returns empty arrays for run with no data", async () => {
    const schema = z.object({ value: z.number() });
    const table = zodToTable("output_a", schema);
    const sqlite = new Database(":memory:");
    sqlite.exec(zodToCreateTableSQL("output_a", schema));
    const db = drizzle(sqlite, { schema: { outputA: table } });

    const outputs = await loadOutputs(db, { outputA: table }, "missing-run");
    expect(outputs.outputA).toBeDefined();
    expect(outputs.outputA.length).toBe(0);
    sqlite.close();
  });
});
