/**
 * When the provider gives Microsandbox's finished exec handles back to the
 * guest: every {@link collectEvery} command starts, through the host's
 * `GarbageCollector`. Why the handles wait for a collection is in
 * `../MicrosandboxSandbox/GarbageCollector.ts`.
 *
 * The count is kept per collector. A host provides one collector for its
 * process, so every provider in it counts toward the same collections, the
 * way they share one heap.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type { GarbageCollector } from "../MicrosandboxSandbox/GarbageCollector.vibe"

/**
 * How many command starts pass between two collections: with the concurrent
 * commands of one session on top, far fewer than the handles a machine
 * refuses at.
 *
 * @category constants
 * @since 0.1.0
 */
export const collectEvery = 64

const counts = new WeakMap<GarbageCollector, number>()

/**
 * Counts one command start toward `collector`'s next collection, and collects
 * on every `every`th.
 *
 * @category constructors
 * @since 1.0.0
 */
export const started = (collector: GarbageCollector, every: number = collectEvery): Effect.Effect<void> =>
  Effect.suspend(() => {
    const count = (counts.get(collector) ?? 0) + 1
    counts.set(collector, count)
    return count % every === 0 ? collector.collect : Effect.void
  })
