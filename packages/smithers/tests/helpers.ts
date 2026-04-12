import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { XmlElement } from "../src";
import { createSmithers } from "../src/index";
import type { z } from "zod";

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

export function createTestSmithers<S extends Record<string, z.ZodObject<any>>>(schemas: S) {
  const dir = mkdtempSync(join(tmpdir(), "smithers-"));
  const dbPath = join(dir, "db.sqlite");
  const api = createSmithers(schemas, { dbPath });
  return {
    ...api,
    dbPath,
    cleanup: () => {
      try {
        (api.db as any).$client?.close?.();
      } catch {}
    },
  };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function el(
  tag: string,
  props: Record<string, string> = {},
  children: any[] = [],
): XmlElement {
  return { kind: "element", tag, props, children } as XmlElement;
}
