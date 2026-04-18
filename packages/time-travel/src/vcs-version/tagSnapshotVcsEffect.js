import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { smithersVcsTags } from "../schema.js";
import { getJjPointer, runJj, } from "@smithers-orchestrator/vcs/jj";
/** @typedef {import("@effect/platform/CommandExecutor").CommandExecutor} CommandExecutor */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("./VcsTag.ts").VcsTag} VcsTag */

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {{ cwd?: string }} [opts]
 * @returns {Effect.Effect<VcsTag | null, SmithersError, CommandExecutor>}
 */
export function tagSnapshotVcs(adapter, runId, frameNo, opts = {}) {
    return Effect.gen(function* () {
        const pointer = yield* getJjPointer(opts.cwd);
        if (!pointer)
            return null;
        // Get current jj operation ID for precise restore
        const opRes = yield* runJj(["operation", "log", "--no-graph", "--limit", "1", "-T", "self.id()"], { cwd: opts.cwd });
        const jjOperationId = opRes.code === 0 ? opRes.stdout.trim() || null : null;
        const ts = nowMs();
        const tag = {
            runId,
            frameNo,
            vcsType: "jj",
            vcsPointer: pointer,
            vcsRoot: opts.cwd ?? null,
            jjOperationId,
            createdAtMs: ts,
        };
        yield* Effect.tryPromise({
            try: () => adapter.db
                .insert(smithersVcsTags)
                .values(tag)
                .onConflictDoUpdate({
                target: [smithersVcsTags.runId, smithersVcsTags.frameNo],
                set: tag,
            }),
            catch: (cause) => toSmithersError(cause, "insert vcs tag", {
                code: "DB_WRITE_FAILED",
                details: { frameNo, runId },
            }),
        });
        yield* Effect.logDebug("VCS tag recorded").pipe(Effect.annotateLogs({
            runId,
            frameNo: String(frameNo),
            vcsPointer: pointer,
        }));
        return tag;
    }).pipe(Effect.annotateLogs({ runId, frameNo: String(frameNo) }), Effect.withLogSpan("time-travel:tag-snapshot-vcs"));
}
