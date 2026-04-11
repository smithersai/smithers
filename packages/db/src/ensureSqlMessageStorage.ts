import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { getSqlMessageStorage } from "./getSqlMessageStorage";

export function ensureSqlMessageStorage(
  db: BunSQLiteDatabase<any> | Database,
): Promise<void> {
  return getSqlMessageStorage(db).ensureSchema();
}
