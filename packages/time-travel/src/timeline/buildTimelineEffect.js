import { Effect } from "effect";
import { listSnapshots } from "../snapshot/listSnapshotsEffect.js";
import { listBranches } from "../fork/listBranchesEffect.js";
import { getBranchInfo } from "../fork/getBranchInfoEffect.js";
/** @typedef {import("../RunTimeline.ts").RunTimeline} RunTimeline */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Effect.Effect<RunTimeline, SmithersError>}
 */
export function buildTimeline(adapter, runId) {
    return Effect.gen(function* () {
        const snapshots = yield* listSnapshots(adapter, runId);
        const branches = yield* listBranches(adapter, runId);
        const ownBranch = yield* getBranchInfo(adapter, runId);
        // Index branches by parent frame number for fast lookup
        const branchByFrame = new Map();
        for (const b of branches) {
            const existing = branchByFrame.get(b.parentFrameNo) ?? [];
            existing.push(b);
            branchByFrame.set(b.parentFrameNo, existing);
        }
        const frames = snapshots.map((s) => ({
            frameNo: s.frameNo,
            createdAtMs: s.createdAtMs,
            contentHash: s.contentHash,
            forkPoints: branchByFrame.get(s.frameNo) ?? [],
        }));
        return {
            runId,
            frames,
            branch: ownBranch ?? null,
        };
    }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("time-travel:build-timeline"));
}
