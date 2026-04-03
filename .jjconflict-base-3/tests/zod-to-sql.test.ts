import { describe, expect, test } from "bun:test";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL";
import { zodToTable } from "../src/zodToTable";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

describe("zodToCreateTableSQL", () => {
  test("generates DDL for simple string schema", () => {
    const schema = z.object({ name: z.string() });
    const ddl = zodToCreateTableSQL("test", schema);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "test"');
    expect(ddl).toContain('"name" TEXT');
    expect(ddl).toContain("run_id TEXT NOT NULL");
    expect(ddl).toContain("node_id TEXT NOT NULL");
    expect(ddl).toContain("iteration INTEGER NOT NULL DEFAULT 0");
    expect(ddl).toContain("PRIMARY KEY (run_id, node_id, iteration)");
  });

  test("maps z.number() to INTEGER", () => {
    const schema = z.object({ count: z.number() });
    const ddl = zodToCreateTableSQL("nums", schema);
    expect(ddl).toContain('"count" INTEGER');
  });

  test("maps z.boolean() to INTEGER", () => {
    const schema = z.object({ active: z.boolean() });
    const ddl = zodToCreateTableSQL("flags", schema);
    expect(ddl).toContain('"active" INTEGER');
  });

  test("maps z.array() to TEXT", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const ddl = zodToCreateTableSQL("arrays", schema);
    expect(ddl).toContain('"tags" TEXT');
  });

  test("maps nested z.object() to TEXT", () => {
    const schema = z.object({ meta: z.object({ key: z.string() }) });
    const ddl = zodToCreateTableSQL("nested", schema);
    expect(ddl).toContain('"meta" TEXT');
  });

  test("converts camelCase keys to snake_case columns", () => {
    const schema = z.object({ myField: z.string() });
    const ddl = zodToCreateTableSQL("snake_test", schema);
    expect(ddl).toContain('"my_field" TEXT');
  });

  test("handles optional fields", () => {
    const schema = z.object({ maybe: z.string().optional() });
    const ddl = zodToCreateTableSQL("opt", schema);
    expect(ddl).toContain('"maybe" TEXT');
  });

  test("handles nullable fields", () => {
    const schema = z.object({ nullable: z.number().nullable() });
    const ddl = zodToCreateTableSQL("null_test", schema);
    expect(ddl).toContain('"nullable" INTEGER');
  });

  test("generated DDL executes without error", () => {
    const schema = z.object({
      title: z.string(),
      count: z.number(),
      active: z.boolean(),
      tags: z.array(z.string()),
    });
    const ddl = zodToCreateTableSQL("real_test", schema);
    const sqlite = new Database(":memory:");
    expect(() => sqlite.exec(ddl)).not.toThrow();
    sqlite.close();
  });
});

describe("zodToTable", () => {
  test("creates a drizzle table usable with insert and select", () => {
    const schema = z.object({ value: z.number() });
    const table = zodToTable("test_table", schema);
    const sqlite = new Database(":memory:");
    sqlite.exec(zodToCreateTableSQL("test_table", schema));
    const db = drizzle(sqlite, { schema: { testTable: table } });

    db.insert(table).values({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      value: 42,
    }).run();

    const rows = db.select().from(table).all();
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(42);
    expect(rows[0].runId).toBe("r1");
    sqlite.close();
  });

  test("handles multiple schema fields", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    });
    const table = zodToTable("multi", schema);
    const sqlite = new Database(":memory:");
    sqlite.exec(zodToCreateTableSQL("multi", schema));
    const db = drizzle(sqlite, { schema: { multi: table } });

    db.insert(table).values({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      name: "test",
      age: 25,
      active: true,
    }).run();

    const rows = db.select().from(table).all();
    expect(rows[0].name).toBe("test");
    expect(rows[0].age).toBe(25);
    sqlite.close();
  });
});
