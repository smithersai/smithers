import type { PrivacyRetirementError } from "../chain/PrivacyRetirement"
import type { WriterMovedToAnotherTabError } from "./StorageRecoveryContract"

// A fenced document cannot publish its failure through the durable store.
// This content-free host signal replaces its UI with the recovery surface.
let failure: PrivacyRetirementError | WriterMovedToAnotherTabError | undefined
const listeners = new Set<() => void>()
export const storageFailure = () => failure
export const subscribeStorageFailure = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const reportStorageFailure = (reason: NonNullable<typeof failure>): void => {
  failure ??= reason
  for (const listener of listeners) listener()
}
