import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { smithersBranches } from "../schema.js";
/** @typedef {import("../BranchInfo.ts").BranchInfo} BranchInfo */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Effect.Effect<BranchInfo | undefined, SmithersError>}
 */
export function getBranchInfo(adapter, runId) {
    return Effect.tryPromise({
        try: () => adapter.db
            .select()
            .from(smithersBranches)
            .where(eq(smithersBranches.runId, runId))
            .limit(1),
        catch: (cause) => toSmithersError(cause, "get branch info", {
            code: "DB_QUERY_FAILED",
            details: { runId },
        }),
    }).pipe(Effect.map((rows) => rows[0]), Effect.annotateLogs({ runId }), Effect.withLogSpan("time-travel:get-branch-info"));
}
