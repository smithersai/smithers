import { parseWikilinks } from "@smthrs/ui/vault"
import type { AppTransition, WorldDocument } from "./AppState"
import { WIKI_DISPLAY_NAME } from "./AppState"

export const archiveNotice = (kept: number, previous: string, temporary: boolean): string =>
  `${
    kept === 0
      ? "Started a new conversation."
      : `Saved ${kept} new note${kept === 1 ? "" : "s"} to ${WIKI_DISPLAY_NAME} and started a new conversation.`
  } [Open the archived conversation](${previous}).${
    temporary ? " This archive is only available until this session closes; local storage is unavailable." : ""
  }`

type Clear = Extract<AppTransition, { readonly type: "conversation.cleared" }>
const pathKey = (path: string): string => path.normalize("NFKC").toLowerCase()

/** All notes are new records; model-chosen titles never select an existing id. */
export const conversationNotes = (
  notes: Clear["notes"],
  existing: ReadonlyArray<WorldDocument>,
  sourceBranchId: string,
  sourceRevision: number,
  branchId: string,
  revision: number,
  updatedAt: number
): WorldDocument[] => {
  const paths = new Set(existing.map((document) => pathKey(document.path)))
  const ids = new Set(existing.map((document) => document.id))
  return notes.map((note, index) => {
    // Prefix also avoids reserved device names (CON, AUX, etc.) on Windows.
    const basename = `Chat notes/Note - ${
      note.title.normalize("NFKC").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/[. ]+$/, "")
    }`
    let path = `${basename}.md`
    let suffix = 2
    while (paths.has(pathKey(path))) path = `${basename} (${suffix++}).md`
    paths.add(pathKey(path))
    let id = `world-sweep-${branchId}-${index}`
    while (ids.has(id)) id += "-new"
    ids.add(id)
    return {
      id,
      path,
      title: note.title,
      body: note.body,
      links: [...new Set(parseWikilinks(note.body).map((link) => link.target).filter(Boolean))],
      tags: [],
      sources: ["chat-sweep", `conversation:${sourceBranchId}@${sourceRevision}`],
      confidence: note.confidence,
      updatedBy: "smithers",
      updatedAt,
      revision
    }
  })
}
