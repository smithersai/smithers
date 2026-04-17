/**
 * Shared per-run single-flight lock table.
 * Used by {@link acquireRewindLock}, {@link hasRewindLock},
 * and {@link resetRewindLocksForTests}.
 *
 * @type {Map<string, symbol>}
 */
export const rewindLockStore = new Map();
