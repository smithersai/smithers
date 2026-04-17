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
/**
 * @param {Parameters<typeof captureSnapshotEffect>} ...args
 */
export function captureSnapshot(...args) {
    return Effect.runPromise(captureSnapshotEffect(...args));
}
/**
 * @param {Parameters<typeof loadSnapshotEffect>} ...args
 */
export function loadSnapshot(...args) {
    return Effect.runPromise(loadSnapshotEffect(...args));
}
/**
 * @param {Parameters<typeof loadLatestSnapshotEffect>} ...args
 */
export function loadLatestSnapshot(...args) {
    return Effect.runPromise(loadLatestSnapshotEffect(...args));
}
/**
 * @param {Parameters<typeof listSnapshotsEffect>} ...args
 */
export function listSnapshots(...args) {
    return Effect.runPromise(listSnapshotsEffect(...args));
}
