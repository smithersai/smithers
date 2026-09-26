import { WriterMovedToAnotherTabError } from "./StorageRecoveryContract"
import { reportStorageFailure } from "./StorageFailure"

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

export const reportWriterMoved = (): void => {
  reportStorageFailure(new WriterMovedToAnotherTabError())
}
