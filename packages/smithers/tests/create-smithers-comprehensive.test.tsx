/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { createSmithers } from "../src/create";
import { z } from "zod";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeSmithers(
  schemas: Record<string, z.ZodObject<any>> = {
    output: z.object({ value: z.number() }),
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "smithers-test-"));
  const dbPath = join(dir, "test.db");
  const api = createSmithers(schemas, { dbPath });
  const cleanup = () => {
    try {
      (api.db as any).$client?.close?.();
    } catch {}
  };
  return { ...api, dbPath, cleanup };
}

describe("createSmithers", () => {
  test("returns all expected API properties", () => {
    const { Workflow, Task, Approval, Sandbox, Timer, useCtx, smithers, db, tables, outputs, cleanup } =
      makeSmithers();
    expect(Workflow).toBeFunction();
    expect(Task).toBeFunction();
    expect(Approval).toBeFunction();
    expect(Sandbox).toBeFunction();
    expect(Timer).toBeFunction();
    expect(useCtx).toBeFunction();
    expect(smithers).toBeFunction();
    expect(db).toBeDefined();
    expect(tables).toBeDefined();
    expect(outputs).toBeDefined();
    cleanup();
  });

  test("creates tables for each schema", () => {
    const { tables, cleanup } = makeSmithers({
      alpha: z.object({ name: z.string() }),
      beta: z.object({ count: z.number() }),
    });
    expect(tables).toHaveProperty("alpha");
    expect(tables).toHaveProperty("beta");
    cleanup();
  });

  test("outputs mirrors schemas", () => {
    const alphaSchema = z.object({ name: z.string() });
    const { outputs, cleanup } = makeSmithers({ alpha: alphaSchema });
    expect(outputs.alpha).toBe(alphaSchema);
    cleanup();
  });

  test("smithers creates a workflow object", () => {
    const { smithers, cleanup } = makeSmithers();
    const workflow = smithers(() => null as any);
    expect(workflow).toBeDefined();
    expect(workflow.db).toBeDefined();
    expect(workflow.build).toBeFunction();
    cleanup();
  });

  test("smithers workflow includes schemaRegistry", () => {
    const { smithers, cleanup } = makeSmithers({
      output: z.object({ value: z.number() }),
    });
    const workflow = smithers(() => null as any);
    expect(workflow.schemaRegistry).toBeDefined();
    expect(workflow.schemaRegistry!.has("output")).toBe(true);
    cleanup();
  });

  test("smithers workflow includes zodToKeyName map", () => {
    const valueSchema = z.object({ value: z.number() });
    const { smithers, cleanup } = makeSmithers({ output: valueSchema });
    const workflow = smithers(() => null as any);
    expect(workflow.zodToKeyName).toBeDefined();
    expect(workflow.zodToKeyName!.get(valueSchema)).toBe("output");
    cleanup();
  });

  test("db is usable for queries", () => {
    const { db, tables, cleanup } = makeSmithers({
      items: z.object({ title: z.string() }),
    });
    // Should be able to insert and select
    (db as any)
      .insert(tables.items)
      .values({ runId: "r1", nodeId: "n1", iteration: 0, title: "hello" })
      .run();
    const rows = (db as any).select().from(tables.items).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("hello");
    cleanup();
  });

  test("handles multiple schemas", () => {
    const { tables, cleanup } = makeSmithers({
      research: z.object({ summary: z.string() }),
      analysis: z.object({ score: z.number(), findings: z.string() }),
    });
    expect(tables.research).toBeDefined();
    expect(tables.analysis).toBeDefined();
    cleanup();
  });

  test("tables use snake_case names", () => {
    const { db, tables, cleanup } = makeSmithers({
      myOutput: z.object({ value: z.number() }),
    });
    // Table name should be snake_case
    const rows = (db as any).select().from(tables.myOutput).all();
    expect(rows).toEqual([]);
    cleanup();
  });

  test("creates input table automatically", () => {
    const { db, cleanup } = makeSmithers();
    // Input table should exist
    const client = (db as any).$client;
    const tables = client
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    const tableNames = tables.map((t: any) => t.name);
    expect(tableNames).toContain("input");
    cleanup();
  });
});
