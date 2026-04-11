import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { getSqlMessageStorage } from "./getSqlMessageStorage";

export function ensureSqlMessageStorageEffect(
  db: BunSQLiteDatabase<any> | Database,
): Effect.Effect<void, never> {
  return getSqlMessageStorage(db).ensureSchemaEffect();
}
