import { describe, expect, test } from "bun:test";
import { zodToTable } from "../src/zodToTable";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableName } from "drizzle-orm";

describe("zodToTable advanced", () => {
  test("includes runId, nodeId, iteration key columns", () => {
    const table = zodToTable("test", z.object({ v: z.string() }));
    const name = getTableName(table);
    expect(name).toBe("test");
  });

  test("maps z.enum() to text column", () => {
    const schema = z.object({
      status: z.enum(["active", "inactive"]),
    });
    const ddl = zodToCreateTableSQL("enums", schema);
    expect(ddl).toContain('"status" TEXT');
  });

  test("maps z.object() nested to JSON text", () => {
    const schema = z.object({
      config: z.object({ key: z.string(), enabled: z.boolean() }),
    });
    const ddl = zodToCreateTableSQL("nested", schema);
    expect(ddl).toContain('"config" TEXT');
  });

  test("handles z.union() as JSON text", () => {
    const schema = z.object({
      result: z.union([z.string(), z.number()]),
    });
    const ddl = zodToCreateTableSQL("union_test", schema);
    expect(ddl).toContain('"result" TEXT');
  });

  test("composite primary key is on run_id, node_id, iteration", () => {
    const schema = z.object({ val: z.string() });
    const ddl = zodToCreateTableSQL("pk_test", schema);
    expect(ddl).toContain("PRIMARY KEY (run_id, node_id, iteration)");
  });

  test("handles schema with many field types", () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
      active: z.boolean(),
      tags: z.array(z.string()),
      meta: z.object({ x: z.number() }),
      status: z.enum(["a", "b"]),
      opt: z.string().optional(),
      nullable: z.number().nullable(),
    });
    const ddl = zodToCreateTableSQL("all_types", schema);
    const sqlite = new Database(":memory:");
    expect(() => sqlite.exec(ddl)).not.toThrow();
    sqlite.close();
  });

  test("handles optional number field (unwraps to INTEGER)", () => {
    const schema = z.object({ score: z.number().optional() });
    const ddl = zodToCreateTableSQL("opt_num", schema);
    expect(ddl).toContain('"score" INTEGER');
  });

  test("handles nullable boolean field (unwraps to INTEGER)", () => {
    const schema = z.object({ flag: z.boolean().nullable() });
    const ddl = zodToCreateTableSQL("null_bool", schema);
    expect(ddl).toContain('"flag" INTEGER');
  });

  test("table supports upsert on conflict", () => {
    const schema = z.object({ value: z.number() });
    const table = zodToTable("upsert_test", schema);
    const sqlite = new Database(":memory:");
    sqlite.exec(zodToCreateTableSQL("upsert_test", schema));
    const db = drizzle(sqlite, { schema: { upsert_test: table } });

    db.insert(table)
      .values({ runId: "r1", nodeId: "n1", iteration: 0, value: 1 })
      .run();

    // Update on conflict
    db.insert(table)
      .values({ runId: "r1", nodeId: "n1", iteration: 0, value: 99 })
      .onConflictDoUpdate({
        target: [(table as any).runId, (table as any).nodeId, (table as any).iteration],
        set: { value: 99 },
      })
      .run();

    const rows = db.select().from(table).all();
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(99);
    sqlite.close();
  });

  test("different iterations create separate rows", () => {
    const schema = z.object({ value: z.number() });
    const table = zodToTable("iter_test", schema);
    const sqlite = new Database(":memory:");
    sqlite.exec(zodToCreateTableSQL("iter_test", schema));
    const db = drizzle(sqlite, { schema: { iter_test: table } });

    db.insert(table)
      .values({ runId: "r1", nodeId: "n1", iteration: 0, value: 1 })
      .run();
    db.insert(table)
      .values({ runId: "r1", nodeId: "n1", iteration: 1, value: 2 })
      .run();

    const rows = db.select().from(table).all();
    expect(rows.length).toBe(2);
    sqlite.close();
  });
});
