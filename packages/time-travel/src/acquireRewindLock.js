import { rewindLockStore } from "./rewindLockStore.js";

/** @typedef {import("./RewindLockHandle.ts").RewindLockHandle} RewindLockHandle */

/**
 * Acquire a single-flight lock for one run.
 * Returns null when another rewind for this run is already in progress.
 *
 * @param {string} runId
 * @returns {RewindLockHandle | null}
 */
export function acquireRewindLock(runId) {
  if (rewindLockStore.has(runId)) {
    return null;
  }
  const token = Symbol(runId);
  rewindLockStore.set(runId, token);
  let released = false;
  return {
    runId,
    release() {
      if (released) {
        return false;
      }
      released = true;
      if (rewindLockStore.get(runId) === token) {
        rewindLockStore.delete(runId);
      }
      return true;
    },
  };
}
