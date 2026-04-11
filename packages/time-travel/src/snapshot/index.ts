import { Effect } from "effect";
import { captureSnapshot as captureSnapshotEffect } from "./captureSnapshotEffect";
import {
  loadLatestSnapshot as loadLatestSnapshotEffect,
  loadSnapshot as loadSnapshotEffect,
} from "./loadSnapshotEffect";
import { listSnapshots as listSnapshotsEffect } from "./listSnapshotsEffect";
export { parseSnapshot } from "./parseSnapshot";

export {
  captureSnapshotEffect,
  listSnapshotsEffect,
  loadLatestSnapshotEffect,
  loadSnapshotEffect,
};

export type { Snapshot } from "./Snapshot";
export type { SnapshotData } from "./SnapshotData";

export function captureSnapshot(
  ...args: Parameters<typeof captureSnapshotEffect>
) {
  return Effect.runPromise(captureSnapshotEffect(...args));
}

export function loadSnapshot(
  ...args: Parameters<typeof loadSnapshotEffect>
) {
  return Effect.runPromise(loadSnapshotEffect(...args));
}

export function loadLatestSnapshot(
  ...args: Parameters<typeof loadLatestSnapshotEffect>
) {
  return Effect.runPromise(loadLatestSnapshotEffect(...args));
}

export function listSnapshots(
  ...args: Parameters<typeof listSnapshotsEffect>
) {
  return Effect.runPromise(listSnapshotsEffect(...args));
}
