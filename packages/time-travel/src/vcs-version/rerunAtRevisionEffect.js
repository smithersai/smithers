import { Effect } from "effect";
import { revertToJjPointer } from "@smithers-orchestrator/vcs/jj";
import { loadVcsTag } from "./loadVcsTagEffect.js";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {{ cwd?: string }} [opts]
 * @returns {Effect.Effect< { restored: boolean; vcsPointer: string | null; error?: string }, SmithersError, CommandExecutor >}
 */
export function rerunAtRevision(adapter, runId, frameNo, opts = {}) {
    return Effect.gen(function* () {
        const tag = yield* loadVcsTag(adapter, runId, frameNo);
        if (!tag) {
            return { restored: false, vcsPointer: null };
        }
        const result = yield* revertToJjPointer(tag.vcsPointer, opts.cwd ?? tag.vcsRoot ?? undefined);
        if (!result.success) {
            return { restored: false, vcsPointer: tag.vcsPointer, error: result.error };
        }
        return { restored: true, vcsPointer: tag.vcsPointer };
    }).pipe(Effect.annotateLogs({ runId, frameNo: String(frameNo) }), Effect.withLogSpan("time-travel:rerun-at-revision"));
}
