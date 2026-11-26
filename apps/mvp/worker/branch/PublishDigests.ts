import { digestSync } from "@smthrs/crypto"
import type { Change } from "./Change.vibe"

/**
 * The key write `name` of write `writeId` carries on GitHub: SHA-256 of both, so every attempt and run of the write
 * derives the same one and no other write does. The route recorded the write id before the flow started.
 */
export const keyOf = (writeId: string, name: "branch" | "commit" | "pull" | "update"): string =>
  digestSync(`smithers/branch-publish/v1\n${name}\n${writeId}`)

/**
 * What GitHub holds of the pushes after `change` lands on `pushed`: each added file's contents' SHA-256 (of their base64),
 * null for each deletion; each `restored` path is the base's again, no longer the pushes'.
 */
export const pushedOf = (
  pushed: Readonly<Record<string, string | null>>,
  change: Change,
  restored: ReadonlyArray<string> = [],
): Record<string, string | null> => {
  const next: Record<string, string | null> = { ...pushed }
  for (const addition of change.additions) next[addition.path] = digestSync(addition.contents)
  for (const deletion of change.deletions) next[deletion] = null
  for (const path of restored) delete next[path]
  return next
}
