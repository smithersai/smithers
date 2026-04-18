import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { smithersBranches } from "../schema.js";
/** @typedef {import("../BranchInfo.ts").BranchInfo} BranchInfo */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

/**
 * @param {SmithersDb} adapter
 * @param {string} parentRunId
 * @returns {Effect.Effect<BranchInfo[], SmithersError>}
 */
export function listBranches(adapter, parentRunId) {
    return Effect.tryPromise({
        try: () => adapter.db
            .select()
            .from(smithersBranches)
            .where(eq(smithersBranches.parentRunId, parentRunId)),
        catch: (cause) => toSmithersError(cause, "list branches", {
            code: "DB_QUERY_FAILED",
            details: { parentRunId },
        }),
    }).pipe(Effect.annotateLogs({ parentRunId }), Effect.withLogSpan("time-travel:list-branches"));
}
