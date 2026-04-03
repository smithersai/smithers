import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "../src/create";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "smithers-create-test-"));
}

describe("createSmithers", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanups) {
      try { fn(); } catch {}
    }
    cleanups.length = 0;
  });

  test("returns all expected API properties", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const api = createSmithers(
      { output: z.object({ value: z.number() }) },
      { dbPath },
    );
    cleanups.push(() => {
      try { (api.db as any).$client?.close?.(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    });

    expect(api.Workflow).toBeFunction();
    expect(api.Task).toBeFunction();
    expect(api.Approval).toBeFunction();
    expect(api.Sequence).toBeDefined();
    expect(api.Parallel).toBeDefined();
    expect(api.Loop).toBeDefined();
    expect(api.Branch).toBeDefined();
    expect(api.Ralph).toBeDefined();
    expect(api.Worktree).toBeDefined();
    expect(api.MergeQueue).toBeDefined();
    expect(api.useCtx).toBeFunction();
    expect(api.smithers).toBeFunction();
    expect(api.db).toBeDefined();
    expect(api.tables).toBeDefined();
    expect(api.outputs).toBeDefined();
  });

  test("creates DB tables from Zod schemas", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const api = createSmithers(
      {
        analysis: z.object({ summary: z.string(), score: z.number() }),
        result: z.object({ answer: z.string() }),
      },
      { dbPath },
    );
    cleanups.push(() => {
      try { (api.db as any).$client?.close?.(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    });

    // Tables should exist in the database
    const sqlite = (api.db as any).$client;
    const tables = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain("input");
    expect(tables).toContain("analysis");
    expect(tables).toContain("result");
  });

  test("creates schema registry entries for each output", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const schemas = {
      output: z.object({ value: z.number() }),
    };
    const api = createSmithers(schemas, { dbPath });
    cleanups.push(() => {
      try { (api.db as any).$client?.close?.(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    });

    expect(api.tables.output).toBeDefined();
    expect(api.outputs.output).toBe(schemas.output);
  });

  test("supports custom journal mode", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const api = createSmithers(
      { out: z.object({ val: z.string() }) },
      { dbPath, journalMode: "DELETE" },
    );
    cleanups.push(() => {
      try { (api.db as any).$client?.close?.(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    });

    const sqlite = (api.db as any).$client;
    const mode = sqlite.query("PRAGMA journal_mode").get();
    expect(mode.journal_mode).toBe("delete");
  });

  test("input table has payload column", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "test.db");
    const api = createSmithers(
      { out: z.object({ val: z.string() }) },
      { dbPath },
    );
    cleanups.push(() => {
      try { (api.db as any).$client?.close?.(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    });

    const sqlite = (api.db as any).$client;
    const cols = sqlite.query('PRAGMA table_info("input")').all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain("run_id");
    expect(colNames).toContain("payload");
  });
});
