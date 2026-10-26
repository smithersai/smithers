import { digestSync } from "@smthrs/crypto"

// A Save's mark on a file's text (docs/features/coedit.md#saved), shared by the browser, which marks what a Save
// wrote, and ChatApi, whose resync brings a saved text to the working copy's new contents
// (docs/features/branch-publish.md#resync).

/** The mark a Save leaves on a file's text: what it wrote, as its length and SHA-256, the same on every device. */
export const SAVED_MARK = "saved"

/** The `saved` mark of `text`: its length, then its SHA-256, so a text of another length is told apart unhashed. */
export const savedMarkOf = (text: string): string => `${text.length}:${digestSync(text)}`
