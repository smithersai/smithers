// @smithers-type-exports-begin
/** @typedef {import("./VcsTag.ts").VcsTag} VcsTag */
// @smithers-type-exports-end

import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { loadVcsTag as loadVcsTagEffect } from "./loadVcsTagEffect.js";
import { rerunAtRevision as rerunAtRevisionEffect } from "./rerunAtRevisionEffect.js";
import { resolveWorkflowAtRevision as resolveWorkflowAtRevisionEffect } from "./resolveWorkflowAtRevisionEffect.js";
import { tagSnapshotVcs as tagSnapshotVcsEffect } from "./tagSnapshotVcsEffect.js";
export { loadVcsTagEffect, rerunAtRevisionEffect, resolveWorkflowAtRevisionEffect, tagSnapshotVcsEffect, };

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * Record the current VCS revision for a run/frame pair.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<VcsTag | null>}
 */
export function tagSnapshotVcs(adapter, runId, frameNo, opts = {}) {
    return Effect.runPromise(tagSnapshotVcsEffect(adapter, runId, frameNo, opts).pipe(Effect.provide(BunContext.layer)));
}
/**
 * Load the VCS revision tag for a run/frame pair, if any.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @returns {Promise<VcsTag | undefined>}
 */
export function loadVcsTag(adapter, runId, frameNo) {
    return Effect.runPromise(loadVcsTagEffect(adapter, runId, frameNo));
}
/**
 * Create a jj workspace at the revision recorded for a run/frame pair.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {string} workspacePath
 * @returns {Promise<{ workspacePath: string; vcsPointer: string } | null>}
 */
export function resolveWorkflowAtRevision(adapter, runId, frameNo, workspacePath) {
    return Effect.runPromise(resolveWorkflowAtRevisionEffect(adapter, runId, frameNo, workspacePath).pipe(Effect.provide(BunContext.layer)));
}
/**
 * Revert the working copy to the VCS revision for a run/frame pair.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<{ restored: boolean; vcsPointer: string | null; error?: string }>}
 */
export function rerunAtRevision(adapter, runId, frameNo, opts = {}) {
    return Effect.runPromise(rerunAtRevisionEffect(adapter, runId, frameNo, opts).pipe(Effect.provide(BunContext.layer)));
}
