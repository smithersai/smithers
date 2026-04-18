import { Effect } from "effect";
import { forkRun as forkRunEffect } from "./forkRunEffect.js";
import { getBranchInfo as getBranchInfoEffect } from "./getBranchInfoEffect.js";
import { listBranches as listBranchesEffect } from "./listBranchesEffect.js";
export { forkRunEffect, getBranchInfoEffect, listBranchesEffect, };

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("../BranchInfo.ts").BranchInfo} BranchInfo */
/** @typedef {import("../ForkParams.ts").ForkParams} ForkParams */
/** @typedef {import("../snapshot/Snapshot.ts").Snapshot} Snapshot */

/**
 * Fork a run at the given frame, returning the child run metadata.
 *
 * @param {SmithersDb} adapter
 * @param {ForkParams} params
 * @returns {Promise<{ runId: string; branch: BranchInfo; snapshot: Snapshot }>}
 */
export function forkRun(adapter, params) {
    return Effect.runPromise(forkRunEffect(adapter, params));
}
/**
 * List branches that were forked from the given parent run.
 *
 * @param {SmithersDb} adapter
 * @param {string} parentRunId
 * @returns {Promise<BranchInfo[]>}
 */
export function listBranches(adapter, parentRunId) {
    return Effect.runPromise(listBranchesEffect(adapter, parentRunId));
}
/**
 * Get the branch record for a run, if any.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<BranchInfo | undefined>}
 */
export function getBranchInfo(adapter, runId) {
    return Effect.runPromise(getBranchInfoEffect(adapter, runId));
}
