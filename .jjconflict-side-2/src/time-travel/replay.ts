import { Effect, Metric } from "effect";
import type { SmithersDb } from "../db/adapter";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import type { SmithersError } from "../utils/errors";
import { forkRunEffect } from "./fork";
import { rerunAtRevision } from "./vcs-version";
import { replaysStarted } from "./metrics";
import type { ReplayParams, BranchInfo, Snapshot } from "./types";

// ---------------------------------------------------------------------------
// Replay = fork + optional VCS restore
// ---------------------------------------------------------------------------

export type ReplayResult = {
  runId: string;
  branch: BranchInfo;
  snapshot: Snapshot;
  vcsRestored: boolean;
  vcsPointer: string | null;
  vcsError?: string;
};

/**
 * Fork a run from a checkpoint, optionally restore the VCS working copy
 * to the revision that was active at the source frame, then return the
 * new run metadata so the caller can resume execution.
 */
export function replayFromCheckpointEffect(
  adapter: SmithersDb,
  params: ReplayParams,
): Effect.Effect<ReplayResult, SmithersError> {
  return Effect.gen(function* () {
    const {
      parentRunId,
      frameNo,
      inputOverrides,
      resetNodes,
      branchLabel,
      restoreVcs,
      cwd,
    } = params;

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
    let vcsPointer: string | null = null;
    let vcsError: string | undefined;

    if (restoreVcs) {
      const vcsResult = yield* fromPromise(
        "rerun at revision",
        () => rerunAtRevision(adapter, parentRunId, frameNo, { cwd }),
      );
      vcsRestored = vcsResult.restored;
      vcsPointer = vcsResult.vcsPointer;
      vcsError = vcsResult.error;
    }

    yield* Metric.increment(replaysStarted);

    yield* Effect.logInfo("Replay started").pipe(
      Effect.annotateLogs({
        parentRunId,
        parentFrameNo: String(frameNo),
        childRunId: runId,
        vcsRestored: String(vcsRestored),
      }),
    );

    return {
      runId,
      branch,
      snapshot,
      vcsRestored,
      vcsPointer,
      vcsError,
    };
  }).pipe(
    Effect.annotateLogs({
      parentRunId: params.parentRunId,
      parentFrameNo: String(params.frameNo),
    }),
    Effect.withLogSpan("time-travel:replay-from-checkpoint"),
  );
}

export function replayFromCheckpoint(
  adapter: SmithersDb,
  params: ReplayParams,
): Promise<ReplayResult> {
  return runPromise(replayFromCheckpointEffect(adapter, params));
}
