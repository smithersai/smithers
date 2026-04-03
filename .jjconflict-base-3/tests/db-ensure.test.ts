import { describe, expect, test } from "bun:test";
import { ensureSmithersTables } from "../src/db/ensure";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

describe("ensureSmithersTables", () => {
  test("creates all internal tables", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);

    const tables = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("_smithers_runs");
    expect(tableNames).toContain("_smithers_nodes");
    expect(tableNames).toContain("_smithers_attempts");
    expect(tableNames).toContain("_smithers_frames");
    expect(tableNames).toContain("_smithers_approvals");
    expect(tableNames).toContain("_smithers_cache");
    expect(tableNames).toContain("_smithers_tool_calls");
    expect(tableNames).toContain("_smithers_events");
    expect(tableNames).toContain("_smithers_ralph");
    sqlite.close();
  });

  test("is idempotent (can be called twice)", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    // Should not throw on second call
    expect(() => ensureSmithersTables(db)).not.toThrow();
    sqlite.close();
  });

  test("tables have expected columns", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);

    const runCols = sqlite
      .query('PRAGMA table_info("_smithers_runs")')
      .all() as { name: string }[];
    const colNames = runCols.map((c) => c.name);
    expect(colNames).toContain("run_id");
    expect(colNames).toContain("status");
    expect(colNames).toContain("created_at_ms");

    const nodeCols = sqlite
      .query('PRAGMA table_info("_smithers_nodes")')
      .all() as { name: string }[];
    const nodeColNames = nodeCols.map((c) => c.name);
    expect(nodeColNames).toContain("run_id");
    expect(nodeColNames).toContain("node_id");
    expect(nodeColNames).toContain("state");

    sqlite.close();
  });
});
