import { isMarkdownPath } from "../repo/paths"
import type { Shared } from "./schema"

// Which open text a frontend shows (docs/features/coedit.md#the-browser). Pure, so the views only render.

/** The prompt of the conversation this tab shows: the one prompt it is in the room of. */
export const promptOf = (texts: ReadonlyArray<Shared>): Shared | undefined =>
  texts.find((row) => row.kind === "prompt" && row.shown)

/** The answer box of run `run`'s question `version`, while this tab has it open. */
export const answerOf = (texts: ReadonlyArray<Shared>, run: string, version: number): Shared | undefined =>
  texts.find((row) => row.kind === "answer" && row.key === `${run}/${version}`)

/** The answer box of run `run`'s open question: the one this tab is in the room of. */
export const openAnswerOf = (texts: ReadonlyArray<Shared>, run: string): Shared | undefined =>
  texts.find((row) => row.kind === "answer" && row.shown && row.key.startsWith(`${run}/`))

/** File `path` of conversation `conversation`'s branch, while this tab has it open. */
export const fileOf = (texts: ReadonlyArray<Shared>, conversation: string, path: string): Shared | undefined =>
  texts.find((row) => row.kind === "file" && row.key === `${conversation}/${path}`)

/**
 * The Markdown file a repository view's page edits in place (docs/features/repo.md#the-browser): file `path` of
 * conversation `conversation`'s branch, when the page shows a file (`kind` `blob`), it is Markdown, and this tab has its
 * text loaded. `undefined` for anything else, a text still loading or one that failed included, so the page shows the
 * read-only document. `conversation` is set only for a person who may write the branch.
 */
export const markdownInPlace = (
  texts: ReadonlyArray<Shared>,
  conversation: string | undefined,
  kind: "tree" | "blob",
  path: string,
): Shared | undefined => {
  if (conversation === undefined || kind !== "blob" || !isMarkdownPath(path)) return undefined
  const file = fileOf(texts, conversation, path)
  return file?.status === "ready" ? file : undefined
}

/** What a file's Save button says: what this tab's Save is doing, else whether the text is what the last Save wrote. */
export const saveLabelOf = (file: Shared): "Saving…" | "Saved" | "Retry save" | "Save" =>
  file.saving ? "Saving…" : file.saved ? "Saved" : file.saveFailed ? "Retry save" : "Save"
