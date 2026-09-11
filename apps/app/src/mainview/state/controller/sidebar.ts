import { DEFAULT_WORKSPACE_NAME, repoTreeRowId } from "../AppState"
import { normalizeTreePath } from "../seams/RepoTreeSeam"
import type { RepoTreeSeam } from "../seams/RepoTreeSeam"
import type { ControllerContext } from "./context"

/*
 * The sidebar's own acts (docs/workbench-lanes/sidebar-tree.md): the file
 * tree's carets (a local checkout or a cloud workspace copy alike) and the
 * workspace heading's name. Every state change goes through the store's
 * dispatcher with the actor recorded; the server is reached only for a
 * directory listing, through the tree seam.
 */
export interface SidebarController {
  /**
   * `repo.tree <copyId>[#path]`: toggle a directory row of a working copy
   * (no path = the copy's root). The first expand loads the directory; a
   * failed row loads again; a loaded row only turns its caret.
   */
  readonly toggleRepoTree: (copyId: string, path?: string) => Promise<string | void>
  /** `workspace.rename <name>`: name the workspace heading; a blank name is refused. */
  readonly renameWorkspace: (name: string) => string | void
  /** The heading's pencil: open or close the inline rename editor. */
  readonly toggleWorkspaceRename: () => void
}

export const createSidebarController = (ctx: ControllerContext, seam: RepoTreeSeam): SidebarController => {
  const { store } = ctx
  const { collections } = store

  const toggleRepoTree: SidebarController["toggleRepoTree"] = async (copyId, pathArg) => {
    const path = normalizeTreePath(pathArg ?? "")
    const copy = collections.workingCopies.get(copyId)
    if (copy === undefined) return `There is no working copy with id ${copyId}.`
    const row = collections.repoTree.get(repoTreeRowId(copyId, path))
    if (row !== undefined && row.expanded) {
      store.dispatch({ type: "repo-tree.toggled", actor: "user", copyId, path, expanded: false })
      return
    }
    if (row !== undefined && row.state !== "failed") {
      // Loaded, or a load already in flight: the caret turns and the listing shows as it is.
      store.dispatch({ type: "repo-tree.toggled", actor: "user", copyId, path, expanded: true })
      return
    }
    store.dispatch({ type: "repo-tree.loading", actor: "user", copyId, path })
    await seam.loadDirectory(copyId, path)
  }

  const renameWorkspace: SidebarController["renameWorkspace"] = (name) => {
    const trimmed = name.trim()
    if (trimmed === "") return `workspace.rename needs a name — the heading reads "${DEFAULT_WORKSPACE_NAME}" until you give one`
    store.dispatch({ type: "workspace.renamed", actor: ctx.commandActor, name: trimmed })
  }

  const toggleWorkspaceRename: SidebarController["toggleWorkspaceRename"] = () => {
    store.dispatch({ type: "workspace.rename.toggled", actor: "user", open: store.session().workspaceRenameOpen !== true })
  }

  return { toggleRepoTree, renameWorkspace, toggleWorkspaceRename }
}
