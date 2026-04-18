import { eq } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("drizzle-orm").Table} Table */

/**
 * @param {BunSQLiteDatabase<Record<string, never>>} db
 * @param {Table} inputTable
 * @param {string} runId
 * @returns {Effect.Effect<Record<string, unknown> | undefined, SmithersError>}
 */
export function loadInput(db, inputTable, runId) {
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
