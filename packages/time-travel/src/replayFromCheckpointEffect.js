import { Effect, Metric } from "effect";
import { forkRun as forkRunEffect } from "./fork/forkRunEffect.js";
import { rerunAtRevision as rerunAtRevisionEffect } from "./vcs-version/rerunAtRevisionEffect.js";
import { replaysStarted } from "./replaysStarted.js";

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./ReplayParams.ts").ReplayParams} ReplayParams */
/** @typedef {import("./ReplayResult.ts").ReplayResult} ReplayResult */

/**
 * Fork a run from a checkpoint, optionally restore the VCS working copy
 * to the revision that was active at the source frame, then return the
 * new run metadata so the caller can resume execution.
 *
 * @param {SmithersDb} adapter
 * @param {ReplayParams} params
 */
export function replayFromCheckpoint(adapter, params) {
    return Effect.gen(function* () {
        const { parentRunId, frameNo, inputOverrides, resetNodes, branchLabel, restoreVcs, cwd, } = params;
        // 1. Fork the run
        const { runId, branch, snapshot } = yield* forkRunEffect(adapter, {
            parentRunId,
            frameNo,
            inputOverrides,
            resetNodes,
            branchLabel,
            forkDescription: `Replay from ${parentRunId}:${frameNo}`,
        });
        // 2. Optionally restore VCS state
        let vcsRestored = false;
        let vcsPointer = null;
        let vcsError;
        if (restoreVcs) {
            const vcsResult = yield* rerunAtRevisionEffect(adapter, parentRunId, frameNo, { cwd });
            vcsRestored = vcsResult.restored;
            vcsPointer = vcsResult.vcsPointer;
            vcsError = vcsResult.error;
        }
        yield* Metric.increment(replaysStarted);
        yield* Effect.logInfo("Replay started").pipe(Effect.annotateLogs({
            parentRunId,
            parentFrameNo: String(frameNo),
            childRunId: runId,
            vcsRestored: String(vcsRestored),
        }));
        return {
            runId,
            branch,
            snapshot,
            vcsRestored,
            vcsPointer,
            vcsError,
        };
    }).pipe(Effect.annotateLogs({
        parentRunId: params.parentRunId,
        parentFrameNo: String(params.frameNo),
    }), Effect.withLogSpan("time-travel:replay-from-checkpoint"));
}
