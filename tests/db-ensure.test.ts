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
    expect(tableNames).toContain("_smithers_sandboxes");
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

    const attemptCols = sqlite
      .query('PRAGMA table_info("_smithers_attempts")')
      .all() as { name: string }[];
    const attemptColNames = attemptCols.map((c) => c.name);
    expect(attemptColNames).toContain("heartbeat_at_ms");
    expect(attemptColNames).toContain("heartbeat_data_json");

    const frameCols = sqlite
      .query('PRAGMA table_info("_smithers_frames")')
      .all() as { name: string }[];
    const frameColNames = frameCols.map((c) => c.name);
    expect(frameColNames).toContain("encoding");

    const runIndexes = sqlite
      .query('PRAGMA index_list("_smithers_runs")')
      .all() as { name: string }[];
    const runIndexNames = runIndexes.map((idx) => idx.name);
    expect(runIndexNames).toContain("_smithers_runs_status_heartbeat_idx");

    sqlite.close();
  });

  test("adds frame encoding column for legacy databases", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE _smithers_frames (
        run_id TEXT NOT NULL,
        frame_no INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        xml_json TEXT NOT NULL,
        xml_hash TEXT NOT NULL,
        mounted_task_ids_json TEXT,
        task_index_json TEXT,
        note TEXT,
        PRIMARY KEY (run_id, frame_no)
      );
      INSERT INTO _smithers_frames (
        run_id,
        frame_no,
        created_at_ms,
        xml_json,
        xml_hash
      ) VALUES (
        'legacy-run',
        0,
        123,
        '{}',
        'abc'
      );
    `);

    const db = drizzle(sqlite);
    ensureSmithersTables(db);

    const frameCols = sqlite
      .query('PRAGMA table_info("_smithers_frames")')
      .all() as { name: string }[];
    expect(frameCols.map((c) => c.name)).toContain("encoding");

    const legacyRow = sqlite
      .query(
        `SELECT encoding FROM _smithers_frames WHERE run_id = 'legacy-run' AND frame_no = 0`,
      )
      .get() as { encoding: string };
    expect(legacyRow.encoding).toBe("full");

    sqlite.close();
  });

  test("adds approval payload columns for legacy databases", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE _smithers_approvals (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        requested_at_ms INTEGER,
        decided_at_ms INTEGER,
        note TEXT,
        decided_by TEXT,
        PRIMARY KEY (run_id, node_id, iteration)
      );
      INSERT INTO _smithers_approvals (
        run_id,
        node_id,
        iteration,
        status
      ) VALUES (
        'legacy-run',
        'gate',
        0,
        'requested'
      );
    `);

    const db = drizzle(sqlite);
    ensureSmithersTables(db);

    const approvalCols = sqlite
      .query('PRAGMA table_info("_smithers_approvals")')
      .all() as { name: string }[];
    const names = approvalCols.map((c) => c.name);
    expect(names).toContain("request_json");
    expect(names).toContain("decision_json");
    expect(names).toContain("auto_approved");

    const legacyRow = sqlite
      .query(
        `SELECT auto_approved FROM _smithers_approvals WHERE run_id = 'legacy-run' AND node_id = 'gate' AND iteration = 0`,
      )
      .get() as { auto_approved: number };
    expect(legacyRow.auto_approved).toBe(0);

    sqlite.close();
  });
});
