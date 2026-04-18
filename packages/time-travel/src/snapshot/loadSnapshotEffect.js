import { and, desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { smithersSnapshots } from "../schema.js";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("./Snapshot.ts").Snapshot} Snapshot */

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @returns {Effect.Effect<Snapshot | undefined, SmithersError>}
 */
export function loadSnapshot(adapter, runId, frameNo) {
    return Effect.tryPromise({
        try: () => adapter.db
            .select()
            .from(smithersSnapshots)
            .where(and(eq(smithersSnapshots.runId, runId), eq(smithersSnapshots.frameNo, frameNo)))
            .limit(1),
        catch: (cause) => toSmithersError(cause, "load snapshot", {
            code: "DB_QUERY_FAILED",
            details: { frameNo, runId },
        }),
    }).pipe(Effect.map((rows) => rows[0]), Effect.annotateLogs({ runId, frameNo: String(frameNo) }), Effect.withLogSpan("time-travel:load-snapshot"));
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Effect.Effect<Snapshot | undefined, SmithersError>}
 */
export function loadLatestSnapshot(adapter, runId) {
    return Effect.tryPromise({
        try: () => adapter.db
            .select()
            .from(smithersSnapshots)
            .where(eq(smithersSnapshots.runId, runId))
            .orderBy(desc(smithersSnapshots.frameNo))
            .limit(1),
        catch: (cause) => toSmithersError(cause, "load latest snapshot", {
            code: "DB_QUERY_FAILED",
            details: { runId },
        }),
    }).pipe(Effect.map((rows) => rows[0]), Effect.annotateLogs({ runId }), Effect.withLogSpan("time-travel:load-latest-snapshot"));
}
