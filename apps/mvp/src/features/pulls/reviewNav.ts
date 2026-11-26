import type { ChangedFile } from "./schema"

// Keyboard-first pull request review navigation (t3code UX architecture P1 #4).
// Supports j/k file traversal, search across filenames and full patches (including collapsed hunks),
// and concrete line-range handoff anchors tied to a comparison and file.

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"])

export type ReviewDiffSide = "old" | "new"

export interface ReviewFileMatch {
  readonly filename: string
  readonly index: number
  readonly filenameMatched: boolean
  readonly patchMatchCount: number
}

export interface LineRangeHandoff {
  readonly comparisonId: string
  readonly filename: string
  readonly startLine: number
  readonly endLine: number
  readonly side: ReviewDiffSide
  readonly promptRef: string
}

export interface ReviewKeyEventLike {
  readonly key: string
  readonly metaKey?: boolean
  readonly ctrlKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
  readonly repeat?: boolean
  readonly defaultPrevented?: boolean
  readonly isComposing?: boolean
  readonly targetTag?: string
  readonly targetEditable?: boolean
}

export type ReviewShortcutAction =
  | { readonly type: "nextFile" }
  | { readonly type: "prevFile" }
  | { readonly type: "focusSearch" }

/**
 * Search changed files by filename and full patch text (including collapsed hunks).
 * An empty or whitespace-only query returns every file in original order.
 */
export function filterChangedFiles(
  files: ReadonlyArray<ChangedFile>,
  query: string,
): ReadonlyArray<ReviewFileMatch> {
  const needle = query.trim().toLowerCase()
  const matches: Array<ReviewFileMatch> = []
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!
    if (needle.length === 0) {
      matches.push({ filename: file.filename, index, filenameMatched: false, patchMatchCount: 0 })
      continue
    }
    const filenameMatched = file.filename.toLowerCase().includes(needle)
    let patchMatchCount = 0
    if (typeof file.patch === "string" && file.patch.length > 0) {
      const lowerPatch = file.patch.toLowerCase()
      let from = 0
      while (true) {
        const hit = lowerPatch.indexOf(needle, from)
        if (hit === -1) break
        patchMatchCount++
        from = hit + needle.length
      }
    }
    if (filenameMatched || patchMatchCount > 0) {
      matches.push({ filename: file.filename, index, filenameMatched, patchMatchCount })
    }
  }
  return matches
}

/**
 * Step to the next or previous changed file cleanly within bounds.
 * Returns null when the file list is empty.
 */
export function stepChangedFile(
  files: ReadonlyArray<{ readonly filename: string }>,
  activeFilename: string | null | undefined,
  direction: "next" | "prev",
): string | null {
  if (files.length === 0) return null
  const currentIndex = activeFilename ? files.findIndex((file) => file.filename === activeFilename) : -1
  if (currentIndex === -1) {
    return direction === "next" ? files[0]!.filename : files[files.length - 1]!.filename
  }
  const targetIndex =
    direction === "next"
      ? Math.min(files.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1)
  return files[targetIndex]!.filename
}

/**
 * Resolve keyboard shortcuts in a pull request comparison while respecting editable targets,
 * IME composition, modifiers, and already-handled events.
 */
export function reviewShortcutAction(event: ReviewKeyEventLike): ReviewShortcutAction | null {
  if (event.defaultPrevented || event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (event.targetEditable || (event.targetTag !== undefined && EDITABLE_TAGS.has(event.targetTag.toUpperCase()))) {
    return null
  }
  if (event.key === "j" && !event.shiftKey) return { type: "nextFile" }
  if (event.key === "k" && !event.shiftKey) return { type: "prevFile" }
  if (event.key === "/" && !event.repeat && !event.shiftKey) return { type: "focusSearch" }
  return null
}

/**
 * Create a normalized, immutable line-range handoff anchored to a concrete comparison and file
 * for routing diff selections into the chat composer.
 */
export function createLineRangeHandoff(input: {
  readonly comparisonId: string
  readonly filename: string
  readonly startLine: number
  readonly endLine: number
  readonly side?: ReviewDiffSide
}): LineRangeHandoff | null {
  const comparisonId = input.comparisonId.trim()
  const filename = input.filename.trim()
  if (comparisonId.length === 0 || filename.length === 0) return null
  if (!Number.isSafeInteger(input.startLine) || !Number.isSafeInteger(input.endLine)) return null
  if (input.startLine <= 0 || input.endLine <= 0) return null
  const startLine = Math.min(input.startLine, input.endLine)
  const endLine = Math.max(input.startLine, input.endLine)
  const side: ReviewDiffSide = input.side ?? "new"
  const rangeLabel = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`
  return {
    comparisonId,
    filename,
    startLine,
    endLine,
    side,
    promptRef: `${filename}:${rangeLabel} (${side})`,
  }
}

/** Stable DOM anchor ID for a changed file card inside a pull request comparison. */
export function changedFileAnchorId(filename: string): string {
  return `diff-file-${filename.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}
