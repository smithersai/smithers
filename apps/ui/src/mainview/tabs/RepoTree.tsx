import { FileTree } from "@smthrs/ui"
import { memo } from "react"
import { useController } from "../ControllerContext"
import { fileArgs } from "../flows/FileArgs"
import type { RepoTreeRow, WorkingCopy } from "../state/AppState"

/* The existing truncated line (cards/FileCards.tsx), so a capped directory says the same thing in both places. */
const TRUNCATED_LINE = "Truncated — the directory holds more entries than the listing shows."

/** The tree's view of one working copy: every loaded row, keyed by path. */
export interface CopyTree {
  readonly root: RepoTreeRow | undefined
  readonly rows: ReadonlyMap<string, RepoTreeRow>
  readonly nodes: ReadonlyArray<string>
  readonly directories: ReadonlyArray<string>
  readonly collapsed: ReadonlySet<string>
}

const EMPTY_TREE: CopyTree = { root: undefined, rows: new Map(), nodes: [], directories: [], collapsed: new Set() }

/**
 * Every copy's tree from one pass over the repoTree rows, looked up by copy
 * id. The sidebar derives this once per change of the rows, never per render
 * or per copy: a render (every streamed token re-renders the shell) hands
 * each tree back unchanged.
 */
export const copyTreesOf = (treeRows: ReadonlyArray<RepoTreeRow>): (copyId: string) => CopyTree => {
  const byCopy = new Map<string, Map<string, RepoTreeRow>>()
  for (const row of treeRows) {
    const rows = byCopy.get(row.copyId) ?? new Map<string, RepoTreeRow>()
    rows.set(row.path, row)
    byCopy.set(row.copyId, rows)
  }
  const trees = new Map<string, CopyTree>()
  for (const [copyId, rows] of byCopy) {
    const nodes: string[] = []
    const directories: string[] = []
    // Rows in path order; each level keeps the order the seam wrote (RepoTreeSeam: dirs first, then by name).
    for (const row of [...rows.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      if (row.state !== "loaded") continue
      for (const entry of row.entries) {
        const full = row.path === "" ? entry.name : `${row.path}/${entry.name}`
        if (entry.kind === "dir") directories.push(full)
        else nodes.push(full)
      }
    }
    const collapsed = new Set(directories.filter((directory) => rows.get(directory)?.expanded !== true))
    trees.set(copyId, { root: rows.get(""), rows, nodes, directories, collapsed })
  }
  return (copyId) => trees.get(copyId) ?? EMPTY_TREE
}

/*
 * The expanded tree under a copy's row: what the route returned, nothing
 * else. Every directory row is `repo.tree <copyId>#<path>`; every file row
 * is the existing file card in the chat (THE EMBED LAW): `files.read <path>
 * <repo>` on a local checkout, `workspace.file <path> <workspaceId>` on a
 * cloud workspace copy, `files.read <path> <org/repo>` on the shared copy
 * (the same public read the files flows make). A directory with nothing
 * loaded shows its row's own state: `loading…`, `empty`, or the route's
 * error text verbatim. Memoized: with its view unchanged, a shell render
 * repaints none of the tree.
 */
export const RepoTree = memo(function RepoTree({
  copy,
  view,
  repoId
}: {
  readonly copy: WorkingCopy
  readonly view: CopyTree
  /** The open local repository a local checkout's files are read through. */
  readonly repoId: string | undefined
}) {
  const controller = useController()
  if (view.root?.expanded !== true) return null
  const fileFlow = copy.kind === "workspace" ? "workspace.file" : "files.read"
  const fileFlowArgs = (path: string): string =>
    copy.kind === "workspace"
      ? fileArgs(path, copy.workspaceId ?? copy.id)
      : copy.kind === "shared"
      ? fileArgs(path, copy.repoId)
      : fileArgs(path, repoId)
  const stateOf = (path: string): string => {
    const row = view.rows.get(path)
    if (row === undefined || row.state === "loading") return "loading…"
    if (row.state === "failed") return row.error ?? "failed"
    return "empty"
  }
  // The root with nothing under it says its own state in place: `loading…`, `empty`, or the refusal verbatim (a box that is not running names its state).
  if (view.nodes.length === 0 && view.directories.length === 0) {
    return (
      <div className="repo-tree" role="presentation" data-testid={`repo-tree-${copy.id}`}>
        <span className="repo-tree-state" data-state={view.root.state} data-testid={`repo-tree-state-${copy.id}#`}>
          {stateOf("")}
        </span>
      </div>
    )
  }
  return (
    <div className="repo-tree" role="presentation" data-testid={`repo-tree-${copy.id}`}>
      <FileTree
        nodes={view.nodes}
        directories={view.directories}
        collapsed={view.collapsed}
        onToggle={(path) => controller.runCommand("repo.tree", `${copy.id}#${path}`)}
        onSelect={(path) => controller.runCommand(fileFlow, fileFlowArgs(path))}
        renderDirectoryEmpty={(path) => (
          <span className="repo-tree-state" data-state={view.rows.get(path)?.state ?? "loading"} data-testid={`repo-tree-state-${copy.id}#${path}`}>
            {stateOf(path)}
          </span>
        )}
        renderDirectoryFooter={(path) => view.rows.get(path)?.truncated === true ? <span className="repo-tree-state">{TRUNCATED_LINE}</span> : null}
        directoryProps={(path) => ({ "data-flow": "repo.tree", "data-testid": `repo-dir-${copy.id}#${path}` })}
        nodeProps={(node) => ({ "data-flow": fileFlow, "data-testid": `repo-file-${copy.id}#${node.path}` })}
      />
    </div>
  )
})
