/**
 * Instance-scoped observations for journal scheduling tests.
 * No mutable journal objects escape through this service.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { RunId } from "../JournalEvent.ts"

/**
 * Read-only observations of one journal instance.
 *
 * @category internal
 * @since 1.0.0
 */
export interface Observations {
  readonly barrierCount: () => number
  readonly policyRunCount: () => number
  readonly admission: (runId: RunId) => Effect.Effect<
    {
      readonly gateClosed: boolean
      readonly permitAvailable: boolean
    } | undefined
  >
}

/**
 * Hooks installed before a journal instance is constructed.
 *
 * @category internal
 * @since 1.0.0
 */
export interface Observer {
  readonly opened: (observations: Observations) => void
  readonly drainRegistered: (runId: RunId) => void
}

/**
 * Absent in ordinary use; tests inject their own instance-scoped observer.
 *
 * @category internal
 * @since 1.0.0
 */
export const JournalTestObserver = Context.Reference<Observer | undefined>("@smthrs/journal/JournalTestObserver", {
  defaultValue: () => undefined
})
