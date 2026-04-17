import { rewindLockStore } from "./rewindLockStore.js";

/**
 * Check whether a run currently holds a rewind lock.
 *
 * @param {string} runId
 * @returns {boolean}
 */
export function hasRewindLock(runId) {
  return rewindLockStore.has(runId);
}
