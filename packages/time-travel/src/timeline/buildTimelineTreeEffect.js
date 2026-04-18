import { Effect } from "effect";
import { buildTimeline } from "./buildTimelineEffect.js";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("../TimelineTree.ts").TimelineTree} TimelineTree */

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Effect.Effect<TimelineTree, SmithersError>}
 */
export function buildTimelineTree(adapter, runId) {
    return Effect.gen(function* () {
        const timeline = yield* buildTimeline(adapter, runId);
        // Collect all child runs that branch from this run
        const childRunIds = [];
        for (const frame of timeline.frames) {
            for (const fork of frame.forkPoints) {
                childRunIds.push(fork.runId);
            }
        }
        // Recursively build subtrees
        const children = [];
        for (const childId of childRunIds) {
            const childTree = yield* buildTimelineTree(adapter, childId);
            children.push(childTree);
        }
        return { timeline, children };
    }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("time-travel:build-timeline-tree"));
}
