/**
 * Symbol extraction, anchor resolution, code-region slicing, and SHA-256 code-hash helpers.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { linesOf, sha256 } from "./internal/FsSafe.ts"
import { lexComments } from "./Lexer.ts"
import type { LanguageFamily, LexedComment } from "./Lexer.ts"

/**
 * Position of a comment relative to its anchored source line.
 *
 * @since 1.0.0
 * @category models
 */
export type Placement = "before" | "inline" | "after"

/**
 * Anchor selector binding an external comment to a file, symbol, line, or pattern.
 *
 * @since 1.0.0
 * @category models
 */
export type AnchorSpec =
  | { readonly kind: "file" }
  | { readonly kind: "symbol"; readonly symbol: string }
  | { readonly kind: "line"; readonly line: number }
  | { readonly kind: "pattern"; readonly pattern: string }

/**
 * Concrete resolved line, code region, and code hash for an anchor.
 *
 * @since 1.0.0
 * @category models
 */
export interface ResolvedAnchor {
  readonly line: number
  readonly codeRegion: string
  readonly codeHash: string
}

/**
 * Extracted top-level or member symbol metadata from a source file.
 *
 * @since 1.0.0
 * @category models
 */
export interface SymbolInfo {
  readonly name: string
  readonly line: number
  readonly params: ReadonlyArray<string>
  readonly callable: boolean
  readonly paramsComplete: boolean
}

/**
 * Typed failure raised when an anchor is missing or ambiguous.
 *
 * @since 1.0.0
 * @category errors
 */
export class AnchorError extends Schema.TaggedError<AnchorError>()("smithers-comments/AnchorError", {
  reason: Schema.Literals(["dangling-anchor", "ambiguous-anchor"]),
  message: Schema.String
}) {}

const NOT_DECLS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "else",
  "do",
  "try",
  "finally",
  "new",
  "throw",
  "typeof",
  "await",
  "yield",
  "delete",
  "case",
  "default"
])

const parseParamList = (raw: string): { readonly params: Array<string>; readonly complete: boolean } => {
  if (raw.trim().length === 0) return { params: [], complete: true }
  const parts: Array<string> = []
  let depth = 0
  let quote = ""
  let cur = ""
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (quote !== "") {
      if (ch === "\\" && i + 1 < raw.length) {
        cur += ch + raw[++i]!
        continue
      }
      if (ch === quote) quote = ""
      cur += ch
      continue
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1)
    else if (ch === "," && depth === 0) {
      parts.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur.trim().length > 0) parts.push(cur)

  const params: Array<string> = []
  let complete = true

  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      complete = false
      continue
    }
    const cleaned = trimmed
      .replace(/^(?:(?:public|private|protected|readonly|mut)\s+)+/, "")
      .replace(/^\.{3}/, "")
      .replace(/^&(?:'\w+\s+)?(?:mut\s+)?/, "")
      .replace(/^\*+/, "")
    const beforeDefault = cleaned.split("=")[0]?.trim() ?? ""
    const beforeType = beforeDefault.split(":")[0]?.trim() ?? ""
    const ident = beforeType.replace(/\?$/, "").trim().split(/\s+/)[0] ?? ""
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ident)) {
      if (ident !== "self" && ident !== "this") params.push(ident)
    } else {
      complete = false
    }
  }

  return { params, complete }
}

/** Replaces comments with spaces (preserving newlines) so text inside comments never creates fake symbols. */
const maskComments = (source: string, language: LanguageFamily): string => {
  const ext = language === "hash" ? "py" : language === "dash" ? "sql" : language === "markup" ? "html" : "ts"
  const comments = lexComments(source, `mask.${ext}`).comments
  if (comments.length === 0) return source
  const out: Array<string> = []
  let cursor = 0
  for (const c of comments) {
    if (c.startOffset > cursor) out.push(source.slice(cursor, c.startOffset))
    let masked = ""
    for (let i = c.startOffset; i < c.endOffset; i++) {
      const ch = source[i]!
      masked += ch === "\n" || ch === "\r" ? ch : " "
    }
    out.push(masked)
    cursor = c.endOffset
  }
  if (cursor < source.length) out.push(source.slice(cursor))
  return out.join("")
}

/**
 * Extracts comment-masked symbol declarations and parameter lists for a language family.
 *
 * @since 1.0.0
 * @category anchors
 */
export const extractSymbols = (source: string, language: LanguageFamily): ReadonlyArray<SymbolInfo> => {
  const masked = maskComments(source, language)
  const lines = linesOf(masked)
  const symbols: Array<SymbolInfo> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const lineNum = i + 1

    if (language === "c-style") {
      let m =
        /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/
          .exec(trimmed)
      if (m) {
        const parsed = parseParamList(m[2] ?? "")
        symbols.push({
          name: m[1]!,
          line: lineNum,
          params: parsed.params,
          callable: true,
          paramsComplete: parsed.complete
        })
        continue
      }
      m = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)/.exec(trimmed)
      if (m) {
        const parsed = parseParamList(m[2] ?? "")
        symbols.push({
          name: m[1]!,
          line: lineNum,
          params: parsed.params,
          callable: true,
          paramsComplete: parsed.complete
        })
        continue
      }
      m =
        /^(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/
          .exec(trimmed)
      if (m) {
        const parsed = parseParamList(m[2] ?? "")
        symbols.push({
          name: m[1]!,
          line: lineNum,
          params: parsed.params,
          callable: true,
          paramsComplete: parsed.complete
        })
        continue
      }
      m =
        /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:class|interface|type|enum|struct|trait|impl|contract|library)\s+([A-Za-z_$][\w$]*)/
          .exec(trimmed)
      if (m) {
        symbols.push({ name: m[1]!, line: lineNum, params: [], callable: false, paramsComplete: true })
        continue
      }
      m =
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::[^=]+)?=>/
          .exec(trimmed)
      if (m) {
        const parsed = parseParamList(m[2] ?? "")
        symbols.push({
          name: m[1]!,
          line: lineNum,
          params: parsed.params,
          callable: true,
          paramsComplete: parsed.complete
        })
        continue
      }
      m = /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/.exec(trimmed)
      if (m) {
        symbols.push({ name: m[1]!, line: lineNum, params: [], callable: false, paramsComplete: true })
        continue
      }
      m =
        /^\s+(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::[^{]+)?\{/
          .exec(line)
      if (m && !NOT_DECLS.has(m[1]!)) {
        const parsed = parseParamList(m[2] ?? "")
        symbols.push({
          name: m[1]!,
          line: lineNum,
          params: parsed.params,
          callable: true,
          paramsComplete: parsed.complete
        })
        continue
      }
    } else if (language === "hash") {
      let m = /^(?:async\s+)?def\s+([A-Za-z_]\w*[?!]?)\s*\(([^)]*)\)/.exec(trimmed)
      if (m) {
        const parsed = parseParamList(m[2] ?? "")
        symbols.push({
          name: m[1]!,
          line: lineNum,
          params: parsed.params,
          callable: true,
          paramsComplete: parsed.complete
        })
        continue
      }
      m = /^(?:class|module)\s+([A-Za-z_][\w:]*)/.exec(trimmed)
      if (m) {
        symbols.push({ name: m[1]!, line: lineNum, params: [], callable: false, paramsComplete: true })
        continue
      }
      m = /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/.exec(trimmed)
      if (m) {
        symbols.push({ name: m[1]!, line: lineNum, params: [], callable: true, paramsComplete: true })
        continue
      }
    } else if (language === "dash") {
      let m = /^(?:local\s+)?function\s+([A-Za-z_][\w.:]*)\s*\(([^)]*)\)/.exec(trimmed)
      if (m) {
        const parsed = parseParamList(m[2] ?? "")
        symbols.push({
          name: m[1]!,
          line: lineNum,
          params: parsed.params,
          callable: true,
          paramsComplete: parsed.complete
        })
        continue
      }
      m =
        /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)/i
          .exec(trimmed)
      if (m) {
        symbols.push({ name: m[1]!, line: lineNum, params: [], callable: false, paramsComplete: true })
        continue
      }
    } else {
      const m = /\bid\s*=\s*["']([^"']+)["']/.exec(trimmed)
      if (m) {
        symbols.push({ name: m[1]!, line: lineNum, params: [], callable: false, paramsComplete: true })
      }
    }
  }

  return symbols
}

/**
 * Computes the canonical 8-character lowercase SHA-256 hash of a normalized code region.
 *
 * @since 1.0.0
 * @category anchors
 */
export const computeCodeHash = (codeRegion: string): string => {
  const normalized = codeRegion
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
  return sha256(normalized).slice(0, 8)
}

const NEXT_DECL_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:function|class|interface|type|enum|struct|trait|impl|def|fn|func|const|let)\b/

/**
 * Extracts up to 5 non-empty lines starting at `line`, stopping at the next independent declaration.
 *
 * @since 1.0.0
 * @category anchors
 */
export const extractCodeRegionFromLines = (
  lines: ReadonlyArray<string>,
  line: number,
  placement: Placement
): string => {
  if (lines.length === 0) return ""
  const clamped = Math.max(1, Math.min(line, lines.length))
  const startIdx = clamped - 1
  if (placement === "inline") return lines[startIdx] ?? ""

  const region: Array<string> = []
  for (let i = startIdx; i < lines.length && region.length < 5; i++) {
    const text = lines[i]!
    const trimmed = text.trim()
    if (trimmed.length === 0) continue
    if (i > startIdx && /^(?:\/\/|#|--)/.test(trimmed)) continue
    if (i > startIdx && NEXT_DECL_RE.test(text)) break
    region.push(text)
  }
  return region.length > 0 ? region.join("\n") : (lines[startIdx] ?? "")
}

/**
 * Slices a declaration-bounded code region from source text around a target line.
 *
 * @since 1.0.0
 * @category anchors
 */
export const extractCodeRegion = (source: string, line: number, placement: Placement): string =>
  extractCodeRegionFromLines(linesOf(source), line, placement)

/**
 * Pre-indexed view of one source file so projecting N comments avoids re-lexing or re-scanning N times.
 *
 * @since 1.0.0
 * @category models
 */
export interface SourceIndex {
  readonly source: string
  readonly language: LanguageFamily
  readonly lines: ReadonlyArray<string>
  readonly symbols: ReadonlyArray<SymbolInfo>
  readonly symbolsByName: ReadonlyMap<string, ReadonlyArray<number>>
  readonly fileBeforeLine: number
  readonly fileAfterLine: number
}

/**
 * Builds a reusable SourceIndex for fast anchor resolution and inference.
 *
 * @since 1.0.0
 * @category anchors
 */
export const indexSource = (source: string, language: LanguageFamily): SourceIndex => {
  const lines = linesOf(source)
  const symbols = extractSymbols(source, language)
  const symbolsByName = new Map<string, Array<number>>()
  for (const s of symbols) {
    const list = symbolsByName.get(s.name)
    if (list) list.push(s.line)
    else symbolsByName.set(s.name, [s.line])
  }

  let beforeIdx = 0
  if (beforeIdx < lines.length && lines[beforeIdx]!.startsWith("#!")) beforeIdx++
  while (beforeIdx < lines.length && /SPDX-License-Identifier:|Copyright\s+/i.test(lines[beforeIdx]!)) beforeIdx++
  const fileBeforeLine = Math.min(lines.length, beforeIdx + 1)

  let afterLine = lines.length
  while (afterLine > 1 && lines[afterLine - 1]!.trim() === "") afterLine--

  return {
    source,
    language,
    lines,
    symbols,
    symbolsByName,
    fileBeforeLine,
    fileAfterLine: afterLine
  }
}

/**
 * Synchronous result union returned by indexed anchor resolution.
 *
 * @since 1.0.0
 * @category models
 */
export type SyncResolution =
  | { readonly ok: true; readonly anchor: ResolvedAnchor }
  | { readonly ok: false; readonly reason: "dangling-anchor" | "ambiguous-anchor"; readonly message: string }

const pickByHintSync = (
  matches: ReadonlyArray<number>,
  lineHint: number | undefined,
  label: string
): { readonly ok: true; readonly line: number } | {
  readonly ok: false
  readonly reason: "dangling-anchor" | "ambiguous-anchor"
  readonly message: string
} => {
  if (matches.length === 0) {
    return { ok: false, reason: "dangling-anchor", message: `Anchor not found: ${label}` }
  }
  if (matches.length === 1) {
    return { ok: true, line: matches[0]! }
  }
  if (lineHint === undefined) {
    return {
      ok: false,
      reason: "ambiguous-anchor",
      message: `Ambiguous anchor (${matches.length} matches) without line hint: ${label}`
    }
  }
  let best = matches[0]!
  let bestDist = Math.abs(best - lineHint)
  for (let i = 1; i < matches.length; i++) {
    const candidate = matches[i]!
    const dist = Math.abs(candidate - lineHint)
    if (dist < bestDist || (dist === bestDist && candidate < best)) {
      best = candidate
      bestDist = dist
    }
  }
  return { ok: true, line: best }
}

/**
 * Resolves an AnchorSpec against a prebuilt SourceIndex.
 *
 * @since 1.0.0
 * @category anchors
 */
export const resolveAnchorIndexed = (
  index: SourceIndex,
  anchor: AnchorSpec,
  placement: Placement,
  lineHint?: number
): SyncResolution => {
  let resolvedLine: number
  if (anchor.kind === "file") {
    resolvedLine = placement === "after" ? index.fileAfterLine : index.fileBeforeLine
  } else if (anchor.kind === "line") {
    const maxAllowed = placement === "after" ? index.lines.length + 1 : index.lines.length
    if (!Number.isSafeInteger(anchor.line) || anchor.line < 1 || anchor.line > maxAllowed) {
      return {
        ok: false,
        reason: "dangling-anchor",
        message: `Line anchor ${anchor.line} out of range (1..${index.lines.length})`
      }
    }
    resolvedLine = Math.min(anchor.line, index.lines.length)
  } else if (anchor.kind === "symbol") {
    const matches = index.symbolsByName.get(anchor.symbol) ?? []
    const picked = pickByHintSync(matches, lineHint, `symbol ${anchor.symbol}`)
    if (!picked.ok) return picked
    resolvedLine = picked.line
  } else {
    if (anchor.pattern.length === 0) {
      return { ok: false, reason: "dangling-anchor", message: "Empty pattern anchor" }
    }
    const matches: Array<number> = []
    for (let i = 0; i < index.lines.length; i++) {
      if (index.lines[i]!.includes(anchor.pattern)) matches.push(i + 1)
    }
    const picked = pickByHintSync(matches, lineHint, `pattern ${anchor.pattern}`)
    if (!picked.ok) return picked
    resolvedLine = picked.line
  }

  const codeRegion = extractCodeRegionFromLines(index.lines, resolvedLine, placement)
  return {
    ok: true,
    anchor: { line: resolvedLine, codeRegion, codeHash: computeCodeHash(codeRegion) }
  }
}

/**
 * Resolves an AnchorSpec synchronously against raw source text.
 *
 * @since 1.0.0
 * @category anchors
 */
export const resolveAnchorSync = (
  source: string,
  language: LanguageFamily,
  anchor: AnchorSpec,
  placement: Placement,
  lineHint?: number
): SyncResolution => resolveAnchorIndexed(indexSource(source, language), anchor, placement, lineHint)

/**
 * Resolves an AnchorSpec as an Effect failing with AnchorError when unresolved.
 *
 * @since 1.0.0
 * @category anchors
 */
export const resolveAnchor = (
  source: string,
  language: LanguageFamily,
  anchor: AnchorSpec,
  placement: Placement,
  lineHint?: number
): Effect.Effect<ResolvedAnchor, AnchorError> =>
  Effect.suspend(() => {
    const res = resolveAnchorSync(source, language, anchor, placement, lineHint)
    return res.ok
      ? Effect.succeed(res.anchor)
      : Effect.fail(new AnchorError({ reason: res.reason, message: res.message }))
  })

/**
 * Infers the best symbol, pattern, line, or file anchor using a prebuilt SourceIndex.
 *
 * @since 1.0.0
 * @category anchors
 */
export const inferAnchorIndexed = (
  index: SourceIndex,
  comment: LexedComment
): { readonly anchor: AnchorSpec; readonly line: number; readonly placement: Placement; readonly codeHash: string } => {
  const placement: Placement = comment.isInline ? "inline" : "before"
  let targetLine = Math.max(1, Math.min(comment.anchorLine, index.lines.length))

  if (!comment.isInline) {
    while (
      targetLine < index.lines.length &&
      (index.lines[targetLine - 1]!.trim() === "" ||
        /^\s*(?:\/\/|\/\*|\*|#|--|<!--)/.test(index.lines[targetLine - 1]!))
    ) {
      targetLine++
    }
  }

  const nearSymbol = index.symbols.find((s) => s.line === targetLine) ??
    (!comment.isInline ? index.symbols.find((s) => s.line >= targetLine && s.line <= targetLine + 2) : undefined)

  if (nearSymbol !== undefined) {
    const region = extractCodeRegionFromLines(index.lines, nearSymbol.line, placement)
    return {
      anchor: { kind: "symbol", symbol: nearSymbol.name },
      line: nearSymbol.line,
      placement,
      codeHash: computeCodeHash(region)
    }
  }

  const lineText = (index.lines[targetLine - 1] ?? "").trim()
  if (lineText.length >= 6 && lineText.length <= 80 && !lineText.includes("\n")) {
    let count = 0
    for (const l of index.lines) {
      if (l.includes(lineText)) count++
      if (count > 1) break
    }
    if (count === 1) {
      const region = extractCodeRegionFromLines(index.lines, targetLine, placement)
      return {
        anchor: { kind: "pattern", pattern: lineText },
        line: targetLine,
        placement,
        codeHash: computeCodeHash(region)
      }
    }
  }

  const region = extractCodeRegionFromLines(index.lines, targetLine, placement)
  return {
    anchor: { kind: "line", line: targetLine },
    line: targetLine,
    placement,
    codeHash: computeCodeHash(region)
  }
}

/**
 * Infers the best AnchorSpec for an extracted inline comment.
 *
 * @since 1.0.0
 * @category anchors
 */
export const inferAnchor = (
  source: string,
  language: LanguageFamily,
  comment: LexedComment
): { readonly anchor: AnchorSpec; readonly line: number; readonly placement: Placement; readonly codeHash: string } =>
  inferAnchorIndexed(indexSource(source, language), comment)
