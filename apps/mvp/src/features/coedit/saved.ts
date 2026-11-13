import { digestSync } from "@smthrs/crypto"

// A Save's mark on a file's text (docs/features/coedit.md#saved), shared by durable save settlement and ChatApi,
// whose resync brings a saved text to the working copy's new contents
// (docs/features/branch-publish.md#resync).

/** The mark a Save leaves on a file's text: what it wrote, as its length and SHA-256, the same on every device. */
export const SAVED_MARK = "saved"

/** The `saved` mark of `text`: its length, then its SHA-256, so a text of another length is told apart unhashed. */
export const savedMarkOf = (text: string): string => `${text.length}:${digestSync(text)}`

/**
 * The name of the mark a Save leaves for the machine's write `sequence`. Each write has its own, so two Saves' marks
 * never replace each other, whichever reaches a replica first: the newest write's is the one that counts (`savedOf`).
 */
export const savedNameOf = (sequence: number): string => `${SAVED_MARK}:${sequence}`

/**
 * The mark that says what the working copy holds: the one of the highest write sequence, else the plain `saved` mark
 * of a Save from before writes were numbered. Its name, so a resync moves that one along, and its value.
 */
export const savedOf = (marks: ReadonlyMap<string, string>): { readonly name: string; readonly value: string | undefined } => {
  let name = SAVED_MARK
  let newest = 0
  for (const candidate of marks.keys()) {
    const sequence = candidate.startsWith(`${SAVED_MARK}:`) ? Number(candidate.slice(SAVED_MARK.length + 1)) : Number.NaN
    if (sequence > newest) {
      newest = sequence
      name = candidate
    }
  }
  return { name, value: marks.get(name) }
}
