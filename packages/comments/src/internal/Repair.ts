/**
 * Internal inline source rewriting, sidecar re-anchoring, and conservative code-hash refresh helpers.
 *
 * @since 1.0.0
 */

import * as Anchor from "../Anchor.ts"
import * as Lexer from "../Lexer.ts"
import * as Sidecar from "../Sidecar.ts"
import type { BoundComment } from "../Validator.ts"
import { renderCommentLines } from "../VirtualFile.ts"
import { eolOf } from "./FsSafe.ts"

/**
 * @since 1.0.0
 * @private
 */
export type EditKind = "update-comment" | "remove-comment" | "refresh-code-hash" | "re-anchor"

/**
 * @since 1.0.0
 * @private
 */
export interface RepairEdit {
  readonly file: string
  readonly commentId: string
  readonly kind: EditKind
  readonly line: number
  readonly before?: string | undefined
  readonly after?: string | undefined
}

/**
 * Applies body replacements or removals cleanly to an inline-mode source file.
 *
 * @since 1.0.0
 * @private
 */
export const repairInlineSource = (
  filePath: string,
  source: string,
  language: Lexer.LanguageFamily,
  comments: ReadonlyArray<BoundComment>,
  repairs: ReadonlyMap<string, string>
): { readonly source: string; readonly edits: ReadonlyArray<RepairEdit> } => {
  const eol = eolOf(source)
  const edits: Array<RepairEdit> = []
  const removals: Array<{ readonly start: number; readonly end: number }> = []
  const sorted = comments
    .filter((c) => c.span !== undefined && repairs.has(c.id))
    .sort((a, b) => a.span!.start - b.span!.start)

  let out = ""
  let cursor = 0

  for (const comment of sorted) {
    const span = comment.span!
    const nextBody = repairs.get(comment.id)
    if (nextBody === undefined || span.start < cursor) continue
    if (nextBody !== "" && nextBody === comment.body) continue

    out += source.slice(cursor, span.start)
    if (nextBody.trim() === "") {
      const start = out.length
      out += source.slice(span.start, span.end)
      removals.push({ start, end: out.length })
      edits.push({
        file: filePath,
        commentId: comment.id,
        kind: "remove-comment",
        line: comment.line,
        before: comment.body
      })
    } else {
      const trailing = comment.isInline && !nextBody.includes("\n")
      const rendered = renderCommentLines(filePath, language, comment.style, nextBody, trailing)
      out += rendered.map((l, idx) => (idx === 0 ? l : comment.indentation + l)).join(eol)
      edits.push({
        file: filePath,
        commentId: comment.id,
        kind: "update-comment",
        line: comment.line,
        before: comment.body,
        after: nextBody
      })
    }
    cursor = span.end
  }

  out += source.slice(cursor)
  return { source: Lexer.removeSpans(out, removals), edits }
}

/**
 * Re-anchors drifted sidecar entries when a unique line in the file carries the exact recorded codeHash.
 *
 * @since 1.0.0
 * @private
 */
export const reanchorSidecar = (
  filePath: string,
  doc: Sidecar.SidecarDocument,
  source: string,
  language: Lexer.LanguageFamily
): { readonly doc: Sidecar.SidecarDocument; readonly edits: ReadonlyArray<RepairEdit> } => {
  const index = Anchor.indexSource(source, language)
  const edits: Array<RepairEdit> = []

  const entries = doc.entries.map((entry) => {
    const res = Anchor.resolveAnchorIndexed(index, entry.anchor, entry.placement, entry.line)
    if (res.ok && (entry.codeHash === undefined || entry.codeHash === res.anchor.codeHash)) {
      if (entry.line !== undefined && entry.line !== res.anchor.line) {
        edits.push({
          file: filePath,
          commentId: entry.id,
          kind: "re-anchor",
          line: res.anchor.line,
          before: `line ${entry.line}`,
          after: `line ${res.anchor.line}`
        })
        return { ...entry, line: res.anchor.line }
      }
      return entry
    }

    if (entry.codeHash === undefined) return entry

    const matchingLines: Array<number> = []
    for (let ln = 1; ln <= index.lines.length; ln++) {
      const hash = Anchor.computeCodeHash(Anchor.extractCodeRegionFromLines(index.lines, ln, entry.placement))
      if (hash === entry.codeHash) matchingLines.push(ln)
    }
    if (matchingLines.length !== 1) return entry
    const targetLine = matchingLines[0]!
    const sym = index.symbols.find((s) => s.line === targetLine)

    const nextAnchor: Anchor.AnchorSpec | undefined = entry.anchor.kind === "line"
      ? { kind: "line", line: targetLine }
      : entry.anchor.kind === "symbol" && sym !== undefined
      ? { kind: "symbol", symbol: sym.name }
      : undefined
    if (nextAnchor === undefined) return entry

    edits.push({
      file: filePath,
      commentId: entry.id,
      kind: "re-anchor",
      line: targetLine,
      before: entry.anchor.kind === "line"
        ? `line ${entry.anchor.line}`
        : `symbol ${entry.anchor.kind === "symbol" ? entry.anchor.symbol : ""}`,
      after: nextAnchor.kind === "line"
        ? `line ${nextAnchor.line}`
        : `symbol ${nextAnchor.kind === "symbol" ? nextAnchor.symbol : ""}`
    })
    return {
      ...entry,
      anchor: nextAnchor,
      ...(entry.line !== undefined ? { line: targetLine } : {})
    }
  })

  return { doc: edits.length === 0 ? doc : { ...doc, entries }, edits }
}

/**
 * Applies body edits and conservative codeHash refreshes to a sidecar document (returns undefined if all entries removed).
 *
 * @since 1.0.0
 * @private
 */
export const repairSidecar = (
  filePath: string,
  doc: Sidecar.SidecarDocument,
  source: string,
  language: Lexer.LanguageFamily,
  repairs: ReadonlyMap<string, string>,
  validatedIds: ReadonlySet<string>
): { readonly doc: Sidecar.SidecarDocument | undefined; readonly edits: ReadonlyArray<RepairEdit> } => {
  const index = Anchor.indexSource(source, language)
  const edits: Array<RepairEdit> = []
  const resolvedLines = new Map<string, number>()
  const kept: Array<Sidecar.SidecarEntry> = []

  for (const entry of doc.entries) {
    const res = Anchor.resolveAnchorIndexed(index, entry.anchor, entry.placement, entry.line)
    const sortLine = res.ok ? res.anchor.line : (entry.line ?? Number.MAX_SAFE_INTEGER)
    const reportLine = res.ok ? res.anchor.line : (entry.line ?? 1)
    resolvedLines.set(entry.id, sortLine)

    const nextBody = repairs.get(entry.id)
    if (nextBody !== undefined && nextBody.trim() === "") {
      edits.push({
        file: filePath,
        commentId: entry.id,
        kind: "remove-comment",
        line: reportLine,
        before: entry.body
      })
      continue
    }

    const bodyChanged = nextBody !== undefined && nextBody !== entry.body
    const currentHash = res.ok ? res.anchor.codeHash : undefined
    const shouldRefreshHash = currentHash !== undefined &&
      entry.codeHash !== undefined &&
      entry.codeHash !== currentHash &&
      (bodyChanged || validatedIds.has(entry.id))

    if (bodyChanged) {
      edits.push({
        file: filePath,
        commentId: entry.id,
        kind: "update-comment",
        line: reportLine,
        before: entry.body,
        after: nextBody
      })
    }
    if (shouldRefreshHash) {
      edits.push({
        file: filePath,
        commentId: entry.id,
        kind: "refresh-code-hash",
        line: reportLine,
        before: entry.codeHash,
        after: currentHash
      })
    }

    kept.push({
      ...entry,
      body: bodyChanged ? nextBody : entry.body,
      ...(shouldRefreshHash ? { codeHash: currentHash } : {}),
      ...(res.ok && entry.line !== undefined ? { line: res.anchor.line } : {})
    })
  }

  if (kept.length === 0) return { doc: undefined, edits }
  const sorted = Sidecar.sortEntries(kept, (e) => resolvedLines.get(e.id) ?? Number.MAX_SAFE_INTEGER)
  return { doc: { ...doc, entries: sorted }, edits }
}
