import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { buildTimelineEffect } from "./buildTimelineEffect";
import type { TimelineTree } from "../TimelineTree";

export function buildTimelineTreeEffect(
  adapter: SmithersDb,
  runId: string,
): Effect.Effect<TimelineTree, SmithersError> {
  return Effect.gen(function* () {
    const timeline = yield* buildTimelineEffect(adapter, runId);

    // Collect all child runs that branch from this run
    const childRunIds: string[] = [];
    for (const frame of timeline.frames) {
      for (const fork of frame.forkPoints) {
        childRunIds.push(fork.runId);
      }
    }

    // Recursively build subtrees
    const children: TimelineTree[] = [];
    for (const childId of childRunIds) {
      const childTree = yield* buildTimelineTreeEffect(adapter, childId);
      children.push(childTree);
    }

    return { timeline, children };
  }).pipe(
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:build-timeline-tree"),
  );
}
