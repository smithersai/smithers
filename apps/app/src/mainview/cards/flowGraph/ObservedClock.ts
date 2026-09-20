import { useMemo, useSyncExternalStore } from "react"

/** Like SyncCards' clock: an external subscription, released with its reader.
 * Local monotonic deltas extend the last engine timestamp without comparing
 * wall clocks on two hosts or inventing a later engine record. */
export const useObservedClock = (recordedAt: number | undefined, running: boolean): number | undefined => {
  const clock = useMemo(() => {
    const receivedAt = performance.now()
    return {
      subscribe: (notify: () => void) => {
        if (!running || recordedAt === undefined) return () => {}
        const timer = setInterval(notify, 1000)
        return () => clearInterval(timer)
      },
      snapshot: () => recordedAt === undefined ? undefined : recordedAt + (running
        ? Math.floor(Math.max(0, performance.now() - receivedAt) / 1000) * 1000 : 0),
      serverSnapshot: () => recordedAt
    }
  }, [recordedAt, running])
  return useSyncExternalStore(clock.subscribe, clock.snapshot, clock.serverSnapshot)
}
