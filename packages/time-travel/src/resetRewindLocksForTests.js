import { rewindLockStore } from "./rewindLockStore.js";

/**
 * Reset lock state for tests.
 */
export function resetRewindLocksForTests() {
  rewindLockStore.clear();
}
