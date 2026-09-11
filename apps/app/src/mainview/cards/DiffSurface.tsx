/*
 * The diff card's hunks (docs/code-intel/PLAN.md §7, L5): one file's patch on
 * `@pierre/diffs` CodeView through `@smthrs/ui/adapters/pierre-diff-view`,
 * the engine and theme mapping the file card's CodeSurface runs on. The
 * adapter is heavy, so ChangeCards loads this module lazily: it is the async
 * chunk boundary and the only place in the app graph that imports the
 * adapter. A patch pierre cannot read stays the verbatim text the seam
 * carried: nothing is drawn that the server did not return.
 */
import { useMemo } from "react"
import { patchToCodeViewItems, PierreDiffView } from "@smthrs/ui/adapters/pierre-diff-view"

/**
 * plue writes each file's patch as go-difflib does (`internal/diffview/
 * diffview.go` buildUnifiedPatch): `--- a/path` / `+++ b/path` labels and the
 * hunks, no `diff --git` line. pierre names a file only from that line, and
 * without it reads the labels as a rename (`a/path → b/path`). The line is
 * built from the seam's own path fields; a patch that already carries one is
 * left alone.
 */
export const gitPatch = (file: { readonly path: string; readonly oldPath?: string | undefined; readonly patch: string }): string =>
  file.patch.startsWith("diff --git ") ? file.patch : `diff --git a/${file.oldPath ?? file.path} b/${file.path}\n${file.patch}`

/** pierre read the patch: it found a file, and every file it found has a hunk. A header with nothing under it is not a diff. */
const readable = (patch: string): boolean => {
  const items = patchToCodeViewItems(patch)
  return items.length > 0 && items.every((item) => item.type === "diff" && item.fileDiff.hunks.length > 0)
}

export const DiffSurface = ({
  path,
  oldPath,
  patch
}: {
  readonly path: string
  readonly oldPath?: string | undefined
  /** The file's unified patch as the change seam carried it. */
  readonly patch: string
}) => {
  const headed = useMemo(() => gitPatch({ path, oldPath, patch }), [path, oldPath, patch])
  const parsed = useMemo(() => readable(headed), [headed])
  return parsed ? <PierreDiffView patch={headed} layout="inline" /> : <pre className="world-card-path">{patch}</pre>
}
