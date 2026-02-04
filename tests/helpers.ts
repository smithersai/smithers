import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

export function createTestDb<Schema>(schema: Schema, ddl: string) {
  const dir = mkdtempSync(join(tmpdir(), "smithers-"));
  const path = join(dir, "db.sqlite");
  const sqlite = new Database(path);
  sqlite.exec(ddl);
  const db = drizzle(sqlite, { schema: schema as any });
  return {
    db,
    sqlite,
    path,
    cleanup: () => sqlite.close(),
  };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
