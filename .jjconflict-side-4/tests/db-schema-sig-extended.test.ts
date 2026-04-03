import { describe, expect, test } from "bun:test";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { schemaSignature } from "../src/db/schema-signature";

describe("schemaSignature", () => {
  test("produces a hex string", () => {
    const table = sqliteTable("test_table", {
      id: text("id").primaryKey(),
      name: text("name").notNull(),
    });
    const sig = schemaSignature(table);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  test("same schema produces same signature", () => {
    const table1 = sqliteTable("test_table", {
      id: text("id").primaryKey(),
      name: text("name").notNull(),
    });
    const table2 = sqliteTable("test_table", {
      id: text("id").primaryKey(),
      name: text("name").notNull(),
    });
    expect(schemaSignature(table1)).toBe(schemaSignature(table2));
  });

  test("different column names produce different signatures", () => {
    const table1 = sqliteTable("test_table", {
      id: text("id").primaryKey(),
      name: text("name"),
    });
    const table2 = sqliteTable("test_table", {
      id: text("id").primaryKey(),
      title: text("title"),
    });
    expect(schemaSignature(table1)).not.toBe(schemaSignature(table2));
  });

  test("different table names produce different signatures", () => {
    const table1 = sqliteTable("table_a", {
      id: text("id").primaryKey(),
    });
    const table2 = sqliteTable("table_b", {
      id: text("id").primaryKey(),
    });
    expect(schemaSignature(table1)).not.toBe(schemaSignature(table2));
  });

  test("different column types produce different signatures", () => {
    const table1 = sqliteTable("test_table", {
      val: text("val"),
    });
    const table2 = sqliteTable("test_table", {
      val: integer("val"),
    });
    expect(schemaSignature(table1)).not.toBe(schemaSignature(table2));
  });

  test("handles table with many columns", () => {
    const table = sqliteTable("big_table", {
      id: text("id").primaryKey(),
      name: text("name").notNull(),
      age: integer("age"),
      score: real("score"),
      active: integer("active", { mode: "boolean" }),
      data: text("data"),
    });
    const sig = schemaSignature(table);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  test("column order does not affect signature (sorted internally)", () => {
    // Both tables have same columns, just defined in different order
    const table1 = sqliteTable("test_table", {
      a: text("a"),
      b: integer("b"),
    });
    const table2 = sqliteTable("test_table", {
      b: integer("b"),
      a: text("a"),
    });
    expect(schemaSignature(table1)).toBe(schemaSignature(table2));
  });
});
