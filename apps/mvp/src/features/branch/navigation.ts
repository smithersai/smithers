import type { BranchView } from "./branch"
import { isMarkdownPath } from "../repo/paths"
import type { TerminalView } from "../terminal/terminal"

/**
 * Opens the live parts of a branch page only while this navigation still owns them. `search.edit` is a file of the
 * working copy in the live editor (`?edit`); `search.file` is the file a blob page shows, which opens in the live editor
 * in place when it is Markdown and this person may write the branch (docs/features/repo.md#the-browser), else stays
 * read-only.
 */
export const openBranchPage = async (
  branch: BranchView,
  terminal: TerminalView,
  signal: AbortSignal,
  params: { readonly owner: string; readonly repo: string; readonly ref: string; readonly _splat?: string },
  search: { readonly terminal?: string; readonly edit?: string; readonly file?: string; readonly compare?: true },
): Promise<void> => {
  try {
    if (signal.aborted) return
    const branchId = await branch.actions.open(params.owner, params.repo, params.ref, signal)
    if (signal.aborted) return
    const { presence, coedit, publishing } = branch
    if (branchId === undefined) {
      await terminal.actions.show(null, undefined, signal)
      if (signal.aborted) return
      await publishing.actions.show(null)
      if (signal.aborted) return
      await presence.actions.leave(signal)
      return
    }
    await presence.actions.join(branchId, signal)
    if (signal.aborted) return
    // Its publication, and under `?compare` what it adds to its base.
    await publishing.actions.show(branchId, search.terminal === undefined && search.compare !== undefined)
    if (signal.aborted) return
    // The file in the live editor under `?edit`, or a blob page's Markdown file for someone who may write it, or none:
    // its room is left with the editor.
    const inPlace = search.file !== undefined && isMarkdownPath(search.file) && branch.actions.writable()
      ? search.file
      : undefined
    const editing = search.terminal === undefined ? search.edit ?? inPlace : undefined
    await coedit.actions.showFile(branchId, editing, signal)
    if (signal.aborted) return
    if (search.terminal === undefined) {
      await terminal.actions.show(null, undefined, signal)
      if (signal.aborted) return
      await presence.actions.at(search.edit === undefined ? { view: "code", path: params._splat ?? "" } : { view: "edit", path: search.edit }, signal)
      return
    }
    terminal.actions.showInBackground(
      branchId,
      search.terminal === "me" ? undefined : search.terminal,
      (terminalId) => signal.aborted ? Promise.resolve() : presence.actions.at({ view: "terminal", terminalId }, signal),
      signal,
    )
  } catch (error) {
    if (!signal.aborted) throw error
  }
}
