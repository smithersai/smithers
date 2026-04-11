import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { SqlMessageStorage } from "./SqlMessageStorage";

export function getSqlMessageStorage(
  db: BunSQLiteDatabase<any> | Database,
): SqlMessageStorage {
  return new SqlMessageStorage(db);
}
