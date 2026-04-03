import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSmithersDb, waitForSmithersDb } from "../src/cli/find-db";

const TMP = join(tmpdir(), `smithers-find-db-test-${Date.now()}`);

function setup() {
  mkdirSync(TMP, { recursive: true });
}

function teardown() {
  rmSync(TMP, { recursive: true, force: true });
}

describe("findSmithersDb", () => {
  test("finds smithers.db in current directory", () => {
    setup();
    try {
      const dbPath = join(TMP, "smithers.db");
      writeFileSync(dbPath, "");
      expect(findSmithersDb(TMP)).toBe(dbPath);
    } finally {
      teardown();
    }
  });

  test("walks upward to find smithers.db in parent", () => {
    setup();
    try {
      const dbPath = join(TMP, "smithers.db");
      writeFileSync(dbPath, "");
      const child = join(TMP, "sub", "deep");
      mkdirSync(child, { recursive: true });
      expect(findSmithersDb(child)).toBe(dbPath);
    } finally {
      teardown();
    }
  });

  test("throws CLI_DB_NOT_FOUND when no db exists", () => {
    setup();
    try {
      expect(() => findSmithersDb(TMP)).toThrow(/No smithers\.db found/);
    } finally {
      teardown();
    }
  });

  test("throws with SmithersError code", () => {
    setup();
    try {
      try {
        findSmithersDb(TMP);
        expect.unreachable("should throw");
      } catch (err: any) {
        expect(err.code).toBe("CLI_DB_NOT_FOUND");
      }
    } finally {
      teardown();
    }
  });

  test("finds db multiple levels up", () => {
    setup();
    try {
      const dbPath = join(TMP, "smithers.db");
      writeFileSync(dbPath, "");
      const deep = join(TMP, "a", "b", "c", "d");
      mkdirSync(deep, { recursive: true });
      expect(findSmithersDb(deep)).toBe(dbPath);
    } finally {
      teardown();
    }
  });

  test("waits briefly for smithers.db to appear", async () => {
    setup();
    try {
      const dbPath = join(TMP, "smithers.db");
      setTimeout(() => writeFileSync(dbPath, ""), 25);
      await expect(
        waitForSmithersDb(TMP, { timeoutMs: 250, intervalMs: 10 }),
      ).resolves.toBe(dbPath);
    } finally {
      teardown();
    }
  });
});
