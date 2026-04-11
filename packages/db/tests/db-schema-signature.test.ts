import { describe, expect, test } from "bun:test";
import { schemaSignature } from "../src/schema-signature";
import { zodToTable } from "../src/zodToTable";
import { z } from "zod";

describe("schemaSignature", () => {
  test("returns a hex string", () => {
    const table = zodToTable("test", z.object({ name: z.string() }));
    const sig = schemaSignature(table);
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });

  test("same schema produces same signature", () => {
    const table1 = zodToTable("test", z.object({ name: z.string() }));
    const table2 = zodToTable("test", z.object({ name: z.string() }));
    expect(schemaSignature(table1)).toBe(schemaSignature(table2));
  });

  test("different schemas produce different signatures", () => {
    const table1 = zodToTable("test", z.object({ name: z.string() }));
    const table2 = zodToTable("test", z.object({ count: z.number() }));
    expect(schemaSignature(table1)).not.toBe(schemaSignature(table2));
  });

  test("different table names produce different signatures", () => {
    const schema = z.object({ name: z.string() });
    const table1 = zodToTable("table_a", schema);
    const table2 = zodToTable("table_b", schema);
    expect(schemaSignature(table1)).not.toBe(schemaSignature(table2));
  });
});
