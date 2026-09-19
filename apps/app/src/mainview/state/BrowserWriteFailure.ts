import type { PlueFault } from "@smthrs/rpc/Refusal"
import { DurableStorageConflictError } from "../chain/DurableCollection"
import { WriterHeldByAnotherTabError, WriterMovedToAnotherTabError } from "./StorageRecoveryContract"

/**
 * Why a durable write this browser attempted did not land.
 *
 * A controller door that REFUSES an edit already owns its sentence. This file
 * is for the other half: an edit the door accepted, whose write to this
 * browser's saved data then FAILED. That half had no vocabulary at all, so it
 * reached the person as a rejected promise — one generic toast, gone after
 * four seconds, while the control that fired it snapped back to the value it
 * already had and the transcript said nothing. The person could not tell a
 * refusal from a lost write, and the only two strings available to describe
 * one were an internal flow id and a storage boundary key.
 *
 * The set is closed and every arm carries its own sentence, so a new way for a
 * write to fail cannot inherit a line that is merely vague, and cannot ship
 * with no line at all: `satisfies Record<BrowserWriteFault, …>` is a compile
 * error until somebody writes the words a person can act on.
 *
 * @since 1.0.0
 * @category models
 */
export type BrowserWriteFault =
  | "writer-moved"
  | "writer-held"
  | "storage-conflict"
  | "storage-full"
  | "storage-unavailable"

interface BrowserWriteCopy {
  /** Whose problem this is, in the same vocabulary every other refusal in the app uses. */
  readonly fault: PlueFault
  /** What the person reads: what did not happen, whose fault it was, and the next act. */
  readonly sentence: string
}

/*
 * `user` here never means "you did something wrong" — it means the act that
 * clears this is the person's, and naming it is more use to them than an
 * apology. The two faults that nothing they can do would have avoided say so
 * in their own words, per the app's rule that infra never blames the reader.
 */
const BROWSER_WRITE_COPY = {
  "writer-moved": {
    fault: "user",
    sentence: "Smithers moved to another tab of this browser, so that change was not saved. Make it again in that tab, or reload this page to take Smithers back here."
  },
  "writer-held": {
    fault: "user",
    sentence: "Smithers is already open in another tab of this browser, so that change was not saved. Use Smithers in that tab, or close it and reload this page, then make the change again."
  },
  "storage-conflict": {
    fault: "infra",
    sentence: "Another Smithers tab saved over this browser's data first, so that change was not saved. Not your fault. Reload the page to pick up the current state, then make the change again."
  },
  "storage-full": {
    fault: "user",
    sentence: "This browser has no room left for Smithers' saved data, so that change was not saved. Free space for this site in your browser settings, then make the change again."
  },
  "storage-unavailable": {
    fault: "infra",
    sentence: "This browser did not save that change. Not your fault, and nothing about the change would have avoided it. Make it again; if it fails twice, reload the page."
  }
} satisfies Record<BrowserWriteFault, BrowserWriteCopy>

/*
 * The quota rejection is the one failure here that arrives as somebody else's
 * type. Browsers disagree on how to spell it — a named DOMException in Chrome
 * and Safari, a legacy numeric code in older Firefox — so all three spellings
 * are read, and nothing is inferred from the message text.
 */
const quotaExceeded = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  const { name, code } = error as { name?: unknown; code?: unknown }
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014
}

/**
 * Classify a thrown durable write. Never reads the failure's prose: each arm
 * is decided by a type this app itself threw, or by the quota spelling the
 * browser used.
 *
 * @since 1.0.0
 * @category constants
 */
export const browserWriteFault = (error: unknown): BrowserWriteFault => {
  if (error instanceof WriterMovedToAnotherTabError) return "writer-moved"
  if (error instanceof WriterHeldByAnotherTabError) return "writer-held"
  if (error instanceof DurableStorageConflictError) return "storage-conflict"
  if (quotaExceeded(error)) return "storage-full"
  return "storage-unavailable"
}

/**
 * The sentence a person reads when a change they made did not reach this
 * browser's saved data. Never carries the thrown message: those name a
 * storage boundary key or a flow id, which is an internal id in front of a
 * person and tells them nothing they can act on.
 *
 * @since 1.0.0
 * @category constants
 */
export const browserWriteRefusal = (error: unknown): string => BROWSER_WRITE_COPY[browserWriteFault(error)].sentence

/**
 * Whose problem a lost write was, for a surface that reports fault classes.
 *
 * @since 1.0.0
 * @category constants
 */
export const browserWriteFaultClass = (error: unknown): PlueFault => BROWSER_WRITE_COPY[browserWriteFault(error)].fault
