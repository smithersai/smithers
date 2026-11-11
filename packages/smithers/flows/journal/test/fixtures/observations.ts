import { Deferred, Effect, Layer } from "effect"
import { JournalTestObserver, type Observations } from "../../src/internal/JournalTestObserver.ts"
import type { RunId } from "../../src/JournalEvent.ts"

/** Captures only the journal instance built with this layer. */
export const observeJournal = () => {
  let observations: Observations
  const drains = new Map<RunId, Deferred.Deferred<void>>()
  const layer = Layer.succeed(JournalTestObserver, {
    opened: (value: Observations) => {
      observations = value
    },
    drainRegistered: (runId: RunId) => {
      const drain = drains.get(runId)
      if (drain !== undefined) Deferred.doneUnsafe(drain, Effect.void)
    }
  })
  return {
    layer,
    watchDrain: (runId: RunId, drain: Deferred.Deferred<void>) => {
      drains.set(runId, drain)
    },
    size: () => observations.barrierCount(),
    policyRunCount: () => observations.policyRunCount(),
    admission: (runId: RunId) => Effect.suspend(() => observations.admission(runId))
  }
}
