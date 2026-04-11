import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { zodToTable } from "../src/zodToTable";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL";

describe("zodToTable", () => {
  test("maps z.string() to text column", () => {
    const table = zodToTable("test_strings", z.object({ name: z.string() }));
    // Verify by creating the table in SQLite
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_strings", z.object({ name: z.string() }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_strings)").all() as any[];
    const nameCol = cols.find((c: any) => c.name === "name");
    expect(nameCol).toBeDefined();
    expect(nameCol.type).toBe("TEXT");

    sqlite.close();
  });

  test("maps z.number() to integer column", () => {
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_nums", z.object({ count: z.number() }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_nums)").all() as any[];
    const countCol = cols.find((c: any) => c.name === "count");
    expect(countCol).toBeDefined();
    expect(countCol.type).toBe("INTEGER");

    sqlite.close();
  });

  test("maps z.boolean() to integer column (boolean mode)", () => {
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_bools", z.object({ active: z.boolean() }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_bools)").all() as any[];
    const activeCol = cols.find((c: any) => c.name === "active");
    expect(activeCol).toBeDefined();
    // SQLite stores booleans as integers
    expect(activeCol.type).toBe("INTEGER");

    sqlite.close();
  });

  test("maps z.array() to text column (json mode)", () => {
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_arrays", z.object({ tags: z.array(z.string()) }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_arrays)").all() as any[];
    const tagsCol = cols.find((c: any) => c.name === "tags");
    expect(tagsCol).toBeDefined();
    expect(tagsCol.type).toBe("TEXT");

    sqlite.close();
  });

  test("maps z.object() to text column (json mode)", () => {
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_objects", z.object({
      meta: z.object({ foo: z.string() }),
    }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_objects)").all() as any[];
    const metaCol = cols.find((c: any) => c.name === "meta");
    expect(metaCol).toBeDefined();
    expect(metaCol.type).toBe("TEXT");

    sqlite.close();
  });

  test("maps z.enum() to text column", () => {
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_enums", z.object({
      status: z.enum(["active", "inactive"]),
    }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_enums)").all() as any[];
    const statusCol = cols.find((c: any) => c.name === "status");
    expect(statusCol).toBeDefined();
    expect(statusCol.type).toBe("TEXT");

    sqlite.close();
  });

  test("always includes run_id, node_id, iteration columns", () => {
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_keys", z.object({ value: z.string() }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_keys)").all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain("run_id");
    expect(colNames).toContain("node_id");
    expect(colNames).toContain("iteration");

    sqlite.close();
  });

  test("converts camelCase keys to snake_case column names", () => {
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_casing", z.object({
      myLongField: z.string(),
      anotherValue: z.number(),
    }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_casing)").all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain("my_long_field");
    expect(colNames).toContain("another_value");

    sqlite.close();
  });

  test("handles z.optional() by unwrapping the inner type", () => {
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_optional", z.object({
      label: z.string().optional(),
    }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_optional)").all() as any[];
    const labelCol = cols.find((c: any) => c.name === "label");
    expect(labelCol).toBeDefined();
    expect(labelCol.type).toBe("TEXT");

    sqlite.close();
  });

  test("handles z.nullable() by unwrapping the inner type", () => {
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_nullable", z.object({
      count: z.number().nullable(),
    }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_nullable)").all() as any[];
    const countCol = cols.find((c: any) => c.name === "count");
    expect(countCol).toBeDefined();
    expect(countCol.type).toBe("INTEGER");

    sqlite.close();
  });

  test("handles z.union() as json text column", () => {
    const sqlite = new Database(":memory:");
    const ddl = zodToCreateTableSQL("test_union", z.object({
      value: z.union([z.string(), z.number()]),
    }));
    sqlite.run(ddl);

    const cols = sqlite.query("PRAGMA table_info(test_union)").all() as any[];
    const valueCol = cols.find((c: any) => c.name === "value");
    expect(valueCol).toBeDefined();
    expect(valueCol.type).toBe("TEXT");

    sqlite.close();
  });
});
