import { Effect } from "effect";
import { ensureSqlMessageStorageEffect } from "./sql-message-storage.js";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} _BunSQLiteDatabase */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} _SmithersError */

/**
 * @param {_BunSQLiteDatabase<Record<string, unknown>>} db
 * @returns {Effect.Effect<void, _SmithersError>}
 */
export function ensureSmithersTablesEffect(db) {
    return ensureSqlMessageStorageEffect(db).pipe(Effect.withLogSpan("db:ensure-smithers-tables"));
}
/**
 * @param {_BunSQLiteDatabase<Record<string, unknown>>} db
 */
export function ensureSmithersTables(db) {
    Effect.runSync(ensureSmithersTablesEffect(db));
}
