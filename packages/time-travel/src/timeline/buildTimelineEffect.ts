import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/core/errors";
import { listSnapshotsEffect } from "../snapshot/listSnapshotsEffect";
import { listBranchesEffect } from "../fork/listBranchesEffect";
import { getBranchInfoEffect } from "../fork/getBranchInfoEffect";
import type { BranchInfo } from "../BranchInfo";
import type { RunTimeline } from "../RunTimeline";
import type { TimelineFrame } from "../TimelineFrame";

export function buildTimelineEffect(
  adapter: SmithersDb,
  runId: string,
): Effect.Effect<RunTimeline, SmithersError> {
  return Effect.gen(function* () {
    const snapshots = yield* listSnapshotsEffect(adapter, runId);
    const branches = yield* listBranchesEffect(adapter, runId);
    const ownBranch = yield* getBranchInfoEffect(adapter, runId);

    // Index branches by parent frame number for fast lookup
    const branchByFrame = new Map<number, BranchInfo[]>();
    for (const b of branches as BranchInfo[]) {
      const existing = branchByFrame.get(b.parentFrameNo) ?? [];
      existing.push(b);
      branchByFrame.set(b.parentFrameNo, existing);
    }

    const frames: TimelineFrame[] = (snapshots as any[]).map((s) => ({
      frameNo: s.frameNo,
      createdAtMs: s.createdAtMs,
      contentHash: s.contentHash,
      forkPoints: branchByFrame.get(s.frameNo) ?? [],
    }));

    return {
      runId,
      frames,
      branch: (ownBranch as BranchInfo | undefined) ?? null,
    };
  }).pipe(
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:build-timeline"),
  );
}
