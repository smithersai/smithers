import { eq, getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Effect, Option } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("@smithers-orchestrator/driver/OutputSnapshot").OutputSnapshot} OutputSnapshot */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("drizzle-orm").Table} _Table */

/**
 * @param {_Table} table
 * @returns {string[]}
 */
function getBooleanColumnKeys(table) {
    try {
        const cols = getTableColumns(table);
        const keys = [];
        for (const [key, col] of Object.entries(cols)) {
            const c = /** @type {Record<string, unknown> & { config?: { mode?: string }; mapFromDriverValue?: unknown }} */ (/** @type {unknown} */ (col));
            const mapFn = /** @type {{ toString?: () => string } | undefined} */ (c?.mapFromDriverValue);
            if (c?.columnType === "SQLiteBoolean" || c?.config?.mode === "boolean" || c?.mode === "boolean" || mapFn?.toString?.().includes("Boolean") || (c?.dataType === "boolean")) {
                keys.push(key);
            }
        }
        return keys;
    } catch {
        return [];
    }
}
/**
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {readonly string[]} boolKeys
 * @returns {Array<Record<string, unknown>>}
 */
function coerceBooleanColumns(rows, boolKeys) {
    if (boolKeys.length === 0) return rows.slice();
    return rows.map((row) => {
        if (!row) return row;
        /** @type {Record<string, unknown>} */
        const patched = { ...row };
        for (const key of boolKeys) {
            if (key in patched && typeof patched[key] !== "boolean") {
                patched[key] = Boolean(patched[key]);
            }
        }
        return patched;
    });
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {_Table} inputTable
 * @param {string} runId
 * @returns {Effect.Effect<Record<string, unknown> | undefined, SmithersError>}
 */
export function loadInputEffect(db, inputTable, runId) {
    const cols = getTableColumns(inputTable);
    const runIdCol = cols.runId;
    if (!runIdCol) {
        throw new SmithersError("DB_MISSING_COLUMNS", "schema.input must include runId column");
    }
    return Effect.tryPromise({
        try: () => db.select().from(inputTable).where(eq(runIdCol, runId)).limit(1),
        catch: (cause) => toSmithersError(cause, "load input", {
            code: "DB_QUERY_FAILED",
            details: { runId },
        }),
    }).pipe(Effect.map((rows) => rows[0]), Effect.annotateLogs({ runId }), Effect.withLogSpan("db:load-input"));
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {_Table} inputTable
 * @param {string} runId
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
export function loadInput(db, inputTable, runId) {
    return Effect.runPromise(loadInputEffect(db, inputTable, runId));
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {Record<string, _Table | unknown>} schema
 * @param {string} runId
 * @returns {Effect.Effect<OutputSnapshot, SmithersError>}
 */
export function loadOutputsEffect(db, schema, runId) {
    return Effect.gen(function* () {
        /** @type {Record<string, ReadonlyArray<Record<string, unknown>>>} */
        const out = {};
        for (const [key, table] of Object.entries(schema)) {
            if (!table || typeof table !== "object") continue;
            if (key === "input") continue;
            const colsOpt = yield* Effect.try({
                try: () => getTableColumns(/** @type {_Table} */ (table)),
                catch: (cause) => toSmithersError(cause, "get table columns", { code: "DB_QUERY_FAILED", details: { runId, schemaKey: key } }),
            }).pipe(Effect.option);
            if (Option.isNone(colsOpt)) continue;
            const cols = colsOpt.value;
            const runIdCol = cols.runId;
            if (!runIdCol) continue;
            const tableNameOpt = yield* Effect.try({
                try: () => getTableName(/** @type {_Table} */ (table)),
                catch: (cause) => toSmithersError(cause, "get table name", { code: "DB_QUERY_FAILED", details: { runId, schemaKey: key } }),
            }).pipe(Effect.option);
            if (Option.isNone(tableNameOpt)) continue;
            const tableName = tableNameOpt.value;
            const rawRows = yield* Effect.tryPromise({
                try: () => db.select().from(/** @type {_Table} */ (table)).where(eq(runIdCol, runId)),
                catch: (cause) => toSmithersError(cause, `load outputs ${tableName}`, { code: "DB_QUERY_FAILED", details: { runId, tableName } }),
            });
            const boolKeys = getBooleanColumnKeys(/** @type {_Table} */ (table));
            const rows = coerceBooleanColumns(rawRows, boolKeys);
            out[tableName] = rows;
            out[key] = rows;
        }
        return /** @type {OutputSnapshot} */ (/** @type {unknown} */ (out));
    }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("db:load-outputs"));
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {Record<string, _Table | unknown>} schema
 * @param {string} runId
 * @returns {Promise<OutputSnapshot>}
 */
export function loadOutputs(db, schema, runId) {
    return Effect.runPromise(loadOutputsEffect(db, schema, runId));
}
