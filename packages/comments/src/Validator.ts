/**
 * Stage 1 structural comment validator for inline and external modes.
 *
 * @since 1.0.0
 */

import * as Anchor from "./Anchor.ts"
import type { CommentsConfig } from "./Config.ts"
import { defaultConfig } from "./Config.ts"
import * as DocTags from "./internal/DocTags.ts"
import * as Lexer from "./Lexer.ts"
import type { SidecarDocument, SidecarEntry } from "./Sidecar.ts"

/**
 * Diagnostic severity level: error or warning.
 *
 * @since 1.0.0
 * @category models
 */
export type Severity = "error" | "warning"

/**
 * Structured lint or semantic validation diagnostic pointing to a source or sidecar location.
 *
 * @since 1.0.0
 * @category models
 */
export interface Diagnostic {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly severity: Severity
  readonly code: string
  readonly commentId?: string
  readonly message: string
}

/**
 * Comment paired with its resolved anchor line, indentation, and code region for validation.
 *
 * @since 1.0.0
 * @category models
 */
export interface BoundComment {
  readonly id: string
  readonly style: Lexer.CommentStyle
  readonly body: string
  readonly line: number
  readonly column: number
  readonly anchorLine: number
  readonly codeRegion: string
  readonly indentation: string
  readonly isInline: boolean
  readonly span?: { readonly start: number; readonly end: number } | undefined
}

/**
 * Constructs a normalized Diagnostic record.
 *
 * @since 1.0.0
 * @category validation
 */
export const diagnostic = (
  file: string,
  line: number,
  code: string,
  message: string,
  commentId?: string,
  severity: Severity = "error",
  column = 1
): Diagnostic => ({
  file,
  line,
  column,
  severity,
  code,
  ...(commentId !== undefined ? { commentId } : {}),
  message
})

const checkCommentBody = (
  file: string,
  commentId: string,
  body: string,
  style: Lexer.CommentStyle,
  line: number,
  column: number,
  anchorLine: number,
  index: Anchor.SourceIndex,
  config: CommentsConfig,
  missingRefPaths?: ReadonlySet<string>
): Array<Diagnostic> => {
  const out: Array<Diagnostic> = []

  if (config.disallowEmptyComments && body.trim().length === 0) {
    out.push(diagnostic(file, line, "empty-comment", "Comment body is empty.", commentId, "error", column))
    return out
  }

  if (config.disallowEmptyTodo && DocTags.isEmptyTodo(body)) {
    out.push(
      diagnostic(
        file,
        line,
        "empty-todo",
        "TODO/FIXME comment must include an explanation.",
        commentId,
        "error",
        column
      )
    )
  }

  if (config.checkRefs) {
    for (const ref of DocTags.findRefs(body)) {
      if (DocTags.isPathRef(ref)) {
        const { path: targetPath } = DocTags.splitPathRef(ref)
        if (missingRefPaths?.has(targetPath)) {
          out.push(
            diagnostic(file, line, "broken-ref", `@ref ${ref} points to a missing path.`, commentId, "error", column)
          )
        }
      } else if (!index.symbolsByName.has(ref)) {
        out.push(
          diagnostic(
            file,
            line,
            "broken-ref",
            `@ref ${ref} does not match any declared symbol in ${file}.`,
            commentId,
            "error",
            column
          )
        )
      }
    }
  }

  if (config.checkJSDocParams && (style === "doc" || body.includes("@param"))) {
    const { tags, malformed } = DocTags.parseParamTags(body)
    for (const _badLine of malformed) {
      out.push(
        diagnostic(file, line, "malformed-param", "@param tag requires a parameter name.", commentId, "error", column)
      )
    }
    if (tags.length > 0) {
      const anchored = index.symbols.find((s) => s.callable && s.line === anchorLine) ??
        index.symbols.find((s) => s.callable && s.line >= anchorLine && s.line <= anchorLine + 2)
      if (anchored !== undefined && anchored.paramsComplete && anchored.params.length > 0) {
        const stale = DocTags.staleParams(tags, anchored.params)
        for (const name of stale) {
          out.push(
            diagnostic(
              file,
              line,
              "stale-param",
              `@param ${name} does not match parameters of ${anchored.name} (${anchored.params.join(", ")}).`,
              commentId,
              "error",
              column
            )
          )
        }
      }
    }
  }

  return out
}

/**
 * Runs Stage 1 structural checks on inline comments in one source file.
 *
 * @since 1.0.0
 * @category validation
 */
export const validateStructuralInline = (
  source: string,
  file: string,
  config: CommentsConfig = defaultConfig,
  missingRefPaths?: ReadonlySet<string>
): {
  readonly language: Lexer.LanguageFamily
  readonly index: Anchor.SourceIndex
  readonly comments: ReadonlyArray<BoundComment>
  readonly diagnostics: ReadonlyArray<Diagnostic>
} => {
  const lexed = Lexer.lexComments(source, file, {
    preservePragmas: config.preservePragmas,
    extraPragmaPatterns: config.extraPragmaPatterns
  })
  const index = Anchor.indexSource(source, lexed.language)
  const diagnostics: Array<Diagnostic> = []
  const comments: Array<BoundComment> = []

  for (const c of lexed.comments) {
    if (c.isPragma) continue
    const placement = c.isInline ? "inline" : "before"
    const codeRegion = Anchor.extractCodeRegionFromLines(index.lines, c.anchorLine, placement)
    comments.push({
      id: c.id,
      style: c.style,
      body: c.body,
      line: c.startLine,
      column: c.startColumn,
      anchorLine: c.anchorLine,
      codeRegion,
      indentation: c.indentation,
      isInline: c.isInline,
      span: { start: c.startOffset, end: c.endOffset }
    })
    diagnostics.push(
      ...checkCommentBody(
        file,
        c.id,
        c.body,
        c.style,
        c.startLine,
        c.startColumn,
        c.anchorLine,
        index,
        config,
        missingRefPaths
      )
    )
  }

  return { language: lexed.language, index, comments, diagnostics }
}

/**
 * Runs Stage 1 structural and anchor checks on an external sidecar document.
 *
 * @since 1.0.0
 * @category validation
 */
export const validateStructuralExternal = (
  source: string,
  file: string,
  sidecar: SidecarDocument | undefined,
  config: CommentsConfig = defaultConfig,
  missingRefPaths?: ReadonlySet<string>
): {
  readonly language: Lexer.LanguageFamily
  readonly index: Anchor.SourceIndex
  readonly comments: ReadonlyArray<BoundComment>
  readonly resolvedEntries: ReadonlyArray<{ readonly entry: SidecarEntry; readonly resolved: Anchor.ResolvedAnchor }>
  readonly diagnostics: ReadonlyArray<Diagnostic>
} => {
  const lexed = Lexer.lexComments(source, file, {
    preservePragmas: config.preservePragmas,
    extraPragmaPatterns: config.extraPragmaPatterns
  })
  const index = Anchor.indexSource(source, lexed.language)
  const diagnostics: Array<Diagnostic> = []
  const comments: Array<BoundComment> = []
  const resolvedEntries: Array<{ readonly entry: SidecarEntry; readonly resolved: Anchor.ResolvedAnchor }> = []

  if (config.strictExternal) {
    for (const c of lexed.comments) {
      if (c.isPragma) continue
      diagnostics.push(
        diagnostic(
          file,
          c.startLine,
          "stray-inline-comment",
          "Non-pragma inline comment found in external mode; run 'smithers-comments extract'.",
          c.id,
          "error",
          c.startColumn
        )
      )
    }
  }

  if (sidecar !== undefined) {
    for (const entry of sidecar.entries) {
      const res = Anchor.resolveAnchorIndexed(index, entry.anchor, entry.placement, entry.line)
      if (!res.ok) {
        diagnostics.push(diagnostic(file, entry.line ?? 1, res.reason, res.message, entry.id))
        continue
      }

      const resolved = res.anchor
      if (entry.codeHash !== undefined && entry.codeHash !== resolved.codeHash) {
        diagnostics.push(
          diagnostic(
            file,
            resolved.line,
            "stale-code-hash",
            `Anchored code changed for @${entry.id} (expected ${entry.codeHash}, got ${resolved.codeHash}).`,
            entry.id
          )
        )
      }

      if (entry.placement === "inline" && entry.body.includes("\n")) {
        diagnostics.push(
          diagnostic(
            file,
            resolved.line,
            "multiline-inline",
            "Multiline inline comment will be projected before its anchor.",
            entry.id,
            "warning"
          )
        )
      }

      diagnostics.push(
        ...checkCommentBody(
          file,
          entry.id,
          entry.body,
          entry.style,
          resolved.line,
          1,
          resolved.line,
          index,
          config,
          missingRefPaths
        )
      )

      resolvedEntries.push({ entry, resolved })
      comments.push({
        id: entry.id,
        style: entry.style,
        body: entry.body,
        line: resolved.line,
        column: 1,
        anchorLine: resolved.line,
        codeRegion: resolved.codeRegion,
        indentation: "",
        isInline: entry.placement === "inline"
      })
    }
  }

  return { language: lexed.language, index, comments, resolvedEntries, diagnostics }
}
