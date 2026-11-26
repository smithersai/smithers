import { Effect } from "effect"

/**
 * A notification from outside any effect (a socket's own event) that starts `renewal` through `fork` unless the one it
 * started is still running: a burst of frames on a lapsed lease costs one fiber, never one each.
 */
export const coalesced = <R>(
  renewal: Effect.Effect<void, never, R>,
  fork: (effect: Effect.Effect<void, never, R>) => unknown,
): () => void => {
  let pending = false
  return () => {
    if (pending) return
    pending = true
    try {
      fork(Effect.ensuring(renewal, Effect.sync(() => void (pending = false))))
    } catch (error) {
      pending = false
      throw error
    }
  }
}
