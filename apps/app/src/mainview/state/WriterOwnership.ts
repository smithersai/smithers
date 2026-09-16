import { WriterMovedToAnotherTabError } from "./StorageRecoveryContract"

const TAKEOVER_KEY = "smithers.writer-takeover"

/** The landing may inspect the request; only the store acquiring the lease consumes it. */
export const writerTakeoverRequested = (): boolean => {
  try { return typeof window !== "undefined" && window.sessionStorage.getItem(TAKEOVER_KEY) === "1" }
  catch { return false }
}

/** Reload first: the new document acquires and keeps the stolen lease through boot. */
export const useSmithersHere = (): void => {
  window.sessionStorage.setItem(TAKEOVER_KEY, "1")
  window.location.reload()
}

export const consumeWriterTakeover = (): boolean => {
  if (typeof window === "undefined") return false
  const requested = writerTakeoverRequested()
  window.sessionStorage.removeItem(TAKEOVER_KEY)
  return requested
}

// Ephemeral ownership of this document, not persisted application state.
let failure: WriterMovedToAnotherTabError | undefined
const listeners = new Set<() => void>()
export const writerOwnershipFailure = () => failure
export const subscribeWriterOwnership = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const reportWriterMoved = (): void => {
  failure ??= new WriterMovedToAnotherTabError()
  for (const listener of listeners) listener()
}
