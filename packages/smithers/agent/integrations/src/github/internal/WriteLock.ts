/**
 * Process-local admission for a keyed GitHub read-and-write sequence.
 * @since 1.0.0
 */

import { Effect, Semaphore } from "effect"

interface Gate {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

// Shared by separately constructed action layers. GitHub provides no remote
// uniqueness constraint: separate processes still need a single owner per key.
const gates = new Map<string, Gate>()

/**
 * Waiters count as users, so cancellation never replaces an occupied gate.
 * @since 1.0.0
 * @category concurrency
 */
export const withWriteLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const gate = gates.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      gates.set(key, gate)
      gate.users++
      return gate
    }),
    (gate) => gate.semaphore.withPermit(effect),
    (gate) =>
      Effect.sync(() => {
        if (--gate.users === 0) gates.delete(key)
      })
  ).pipe(Effect.withSpan("GitHub.Actions.keyed-write"))
