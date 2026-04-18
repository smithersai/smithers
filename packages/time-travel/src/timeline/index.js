import { Effect } from "effect";
import { buildTimeline as buildTimelineEffect } from "./buildTimelineEffect.js";
import { buildTimelineTree as buildTimelineTreeEffect } from "./buildTimelineTreeEffect.js";
export { formatTimelineForTui } from "./formatTimelineForTui.js";
export { formatTimelineAsJson } from "./formatTimelineAsJson.js";
export { buildTimelineEffect, buildTimelineTreeEffect, };

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("../RunTimeline.ts").RunTimeline} RunTimeline */
/** @typedef {import("../TimelineTree.ts").TimelineTree} TimelineTree */

/**
 * Build the flat timeline (snapshots + branches) for a run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<RunTimeline>}
 */
export function buildTimeline(adapter, runId) {
    return Effect.runPromise(buildTimelineEffect(adapter, runId));
}
/**
 * Build the recursive timeline tree (run + all descendants) for a run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<TimelineTree>}
 */
export function buildTimelineTree(adapter, runId) {
    return Effect.runPromise(buildTimelineTreeEffect(adapter, runId));
}
