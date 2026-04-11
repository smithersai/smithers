import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL";

describe("zodToCreateTableSQL", () => {
  test("generates CREATE TABLE statement", () => {
    const schema = z.object({ name: z.string() });
    const sql = zodToCreateTableSQL("test_table", schema);
    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("test_table");
  });

  test("includes smithers key columns", () => {
    const schema = z.object({ val: z.string() });
    const sql = zodToCreateTableSQL("test_keys", schema);
    expect(sql).toContain("run_id");
    expect(sql).toContain("node_id");
    expect(sql).toContain("iteration");
  });

  test("maps string to TEXT", () => {
    const schema = z.object({ name: z.string() });
    const sql = zodToCreateTableSQL("test_string", schema);
    expect(sql).toContain("TEXT");
  });

  test("maps number to INTEGER or REAL", () => {
    const schema = z.object({ count: z.number() });
    const sql = zodToCreateTableSQL("test_number", schema);
    // Number maps to INTEGER
    expect(sql.includes("INTEGER") || sql.includes("REAL")).toBe(true);
  });

  test("maps boolean to INTEGER", () => {
    const schema = z.object({ active: z.boolean() });
    const sql = zodToCreateTableSQL("test_bool", schema);
    expect(sql).toContain("INTEGER");
  });

  test("maps enum to TEXT", () => {
    const schema = z.object({ status: z.enum(["a", "b"]) });
    const sql = zodToCreateTableSQL("test_enum", schema);
    expect(sql).toContain("TEXT");
  });

  test("includes PRIMARY KEY", () => {
    const schema = z.object({ val: z.string() });
    const sql = zodToCreateTableSQL("test_pk", schema);
    expect(sql).toContain("PRIMARY KEY");
  });

  test("handles multiple columns", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    });
    const sql = zodToCreateTableSQL("test_multi", schema);
    expect(sql).toContain("name");
    expect(sql).toContain("age");
    expect(sql).toContain("active");
  });

  test("converts camelCase to snake_case", () => {
    const schema = z.object({ firstName: z.string() });
    const sql = zodToCreateTableSQL("test_camel", schema);
    expect(sql).toContain("first_name");
  });
});
