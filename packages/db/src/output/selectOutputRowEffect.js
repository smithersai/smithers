import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { buildKeyWhere } from "./buildKeyWhere.js";
/** @typedef {import("./OutputKey.ts").OutputKey} OutputKey */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("drizzle-orm").Table} Table */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */

/**
 * @template T
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {Table} table
 * @param {OutputKey} key
 * @returns {Effect.Effect<T | undefined, SmithersError>}
 */
export function selectOutputRow(db, table, key) {
    const where = buildKeyWhere(table, key);
    return Effect.tryPromise({
        try: () => db.select().from(table).where(where).limit(1),
        catch: (cause) => toSmithersError(cause, `select output ${table["_"]?.name ?? "output"}`, {
            code: "DB_QUERY_FAILED",
            details: { outputTable: table["_"]?.name ?? "output" },
        }),
    }).pipe(Effect.map((rows) => rows[0]), Effect.annotateLogs({
        outputTable: table["_"]?.name ?? "output",
        runId: key.runId,
        nodeId: key.nodeId,
        iteration: key.iteration ?? 0,
    }), Effect.withLogSpan("db:select-output-row"));
}
