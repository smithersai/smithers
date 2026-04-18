import { Effect } from "effect";
import { revertToJjPointer } from "@smithers-orchestrator/vcs/jj";
import * as BunContext from "@effect/platform-bun/BunContext";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
/** @typedef {import("./RevertOptions.ts").RevertOptions} RevertOptions */
/** @typedef {import("./RevertResult.ts").RevertResult} RevertResult */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {SmithersDb} adapter
 * @param {RevertOptions} opts
 * @returns {Promise<RevertResult>}
 */
export async function revertToAttempt(adapter, opts) {
    const { runId, nodeId, iteration, attempt, onProgress } = opts;
    const attemptRow = await Effect.runPromise(adapter.getAttempt(runId, nodeId, iteration, attempt));
    if (!attemptRow) {
        return {
            success: false,
            error: `Attempt not found: ${runId}/${nodeId}/${iteration}/${attempt}`,
        };
    }
    const jjPointer = attemptRow.jjPointer;
    if (!jjPointer) {
        return { success: false, error: `Attempt has no jjPointer recorded` };
    }
    onProgress?.({
        type: "RevertStarted",
        runId,
        nodeId,
        iteration,
        attempt,
        jjPointer,
        timestampMs: nowMs(),
    });
    // Revert must target the same repository/worktree where the attempt ran.
    const cwd = attemptRow.jjCwd ?? undefined;
    const result = await Effect.runPromise(revertToJjPointer(jjPointer, cwd).pipe(Effect.provide(BunContext.layer)));
    onProgress?.({
        type: "RevertFinished",
        runId,
        nodeId,
        iteration,
        attempt,
        jjPointer,
        success: result.success,
        error: result.error,
        timestampMs: nowMs(),
    });
    if (!result.success) {
        return { success: false, error: result.error, jjPointer };
    }
    // Clean up DB frames recorded after the reverted attempt started.
    // Find the latest frame created before the attempt's start time and
    // discard everything after it so the DB matches the reverted VCS state.
    const frames = await Effect.runPromise(adapter.listFrames(runId, 1_000_000));
    const cutoff = attemptRow.startedAtMs;
    let lastValidFrameNo = -1;
    for (const f of frames) {
        if (f.createdAtMs <= cutoff && f.frameNo > lastValidFrameNo) {
            lastValidFrameNo = f.frameNo;
        }
    }
    if (lastValidFrameNo >= 0) {
        await Effect.runPromise(adapter.deleteFramesAfter(runId, lastValidFrameNo));
    }
    return { success: true, jjPointer };
}
