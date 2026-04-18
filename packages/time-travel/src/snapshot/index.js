// @smithers-type-exports-begin
/** @typedef {import("./Snapshot.ts").Snapshot} Snapshot */
/** @typedef {import("./SnapshotData.ts").SnapshotData} SnapshotData */
// @smithers-type-exports-end

import { Effect } from "effect";
import { captureSnapshot as captureSnapshotEffect } from "./captureSnapshotEffect.js";
import { loadLatestSnapshot as loadLatestSnapshotEffect, loadSnapshot as loadSnapshotEffect, } from "./loadSnapshotEffect.js";
import { listSnapshots as listSnapshotsEffect } from "./listSnapshotsEffect.js";
export { parseSnapshot } from "./parseSnapshot.js";
export { captureSnapshotEffect, listSnapshotsEffect, loadLatestSnapshotEffect, loadSnapshotEffect, };

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * Capture a snapshot row for a run at a given frame.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {SnapshotData} data
 * @returns {Promise<Snapshot>}
 */
export function captureSnapshot(adapter, runId, frameNo, data) {
    return Effect.runPromise(captureSnapshotEffect(adapter, runId, frameNo, data));
}
/**
 * Load a specific snapshot row for a run/frame.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @returns {Promise<Snapshot | undefined>}
 */
export function loadSnapshot(adapter, runId, frameNo) {
    return Effect.runPromise(loadSnapshotEffect(adapter, runId, frameNo));
}
/**
 * Load the most recent snapshot row for a run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<Snapshot | undefined>}
 */
export function loadLatestSnapshot(adapter, runId) {
    return Effect.runPromise(loadLatestSnapshotEffect(adapter, runId));
}
/**
 * List lightweight snapshot index rows for a run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<Array<Pick<Snapshot, "runId" | "frameNo" | "contentHash" | "createdAtMs" | "vcsPointer">>>}
 */
export function listSnapshots(adapter, runId) {
    return Effect.runPromise(listSnapshotsEffect(adapter, runId));
}
