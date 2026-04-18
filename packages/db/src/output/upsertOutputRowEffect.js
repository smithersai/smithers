import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { withSqliteWriteRetryEffect } from "../write-retry.js";
import { getKeyColumns } from "./getKeyColumns.js";
/** @typedef {import("./OutputKey.ts").OutputKey} OutputKey */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("drizzle-orm").Table} Table */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */

/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {Table} table
 * @param {OutputKey} key
 * @param {Record<string, unknown>} payload
 * @returns {Effect.Effect<void, SmithersError>}
 */
export function upsertOutputRow(db, table, key, payload) {
    const cols = getKeyColumns(table);
    const values = { ...payload };
    values.runId = key.runId;
    values.nodeId = key.nodeId;
    if (cols.iteration) {
        values.iteration = key.iteration ?? 0;
    }
    const target = cols.iteration ? [cols.runId, cols.nodeId, cols.iteration] : [cols.runId, cols.nodeId];
    return withSqliteWriteRetryEffect(() => Effect.tryPromise({
        try: () => db.insert(table).values(values).onConflictDoUpdate({ target, set: values }),
        catch: (cause) => toSmithersError(cause, `upsert output ${table["_"]?.name ?? "output"}`, {
            code: "DB_WRITE_FAILED",
            details: { outputTable: table["_"]?.name ?? "output" },
        }),
    }), { label: `upsert output ${table["_"]?.name ?? "output"}` }).pipe(Effect.asVoid, Effect.annotateLogs({
        outputTable: table["_"]?.name ?? "output",
        runId: key.runId,
        nodeId: key.nodeId,
        iteration: key.iteration ?? 0,
    }), Effect.withLogSpan("db:upsert-output-row"));
}
