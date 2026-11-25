/**
 * Single-pass multi-language comment lexer and pragma-preserving prose comment stripper.
 *
 * @since 1.0.0
 */

import * as Path from "node:path"
import { eolOf, leadingIndent, trailingNewline } from "./internal/FsSafe.ts"

/**
 * Comment syntax family detected from a source file extension.
 *
 * @since 1.0.0
 * @category models
 */
export type LanguageFamily = "c-style" | "hash" | "dash" | "markup"
/**
 * Normalized style classification of a lexed or rendered comment.
 *
 * @since 1.0.0
 * @category models
 */
export type CommentStyle = "line" | "block" | "doc"

/**
 * Single comment span extracted by the multi-language lexer.
 *
 * @since 1.0.0
 * @category models
 */
export interface LexedComment {
  readonly id: string
  readonly style: CommentStyle
  readonly raw: string
  readonly body: string
  readonly startOffset: number
  readonly endOffset: number
  readonly startLine: number
  readonly endLine: number
  readonly startColumn: number
  readonly endColumn: number
  readonly isInline: boolean
  readonly isPragma: boolean
  readonly anchorLine: number
  readonly indentation: string
}

/**
 * Complete lexing output for one source file including comment spans and pragmas.
 *
 * @since 1.0.0
 * @category models
 */
export interface LexResult {
  readonly language: LanguageFamily
  readonly comments: ReadonlyArray<LexedComment>
  readonly lineCount: number
  readonly eol: "\n" | "\r\n"
  readonly hasTrailingNewline: boolean
}

/**
 * Options controlling pragma preservation during lexing and stripping.
 *
 * @since 1.0.0
 * @category models
 */
export interface LexOptions {
  readonly preservePragmas?: boolean
  readonly extraPragmaPatterns?: ReadonlyArray<string>
}

const C_STYLE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vibe",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".hpp",
  ".java",
  ".kt",
  ".swift",
  ".cs",
  ".zig",
  ".sol",
  ".css",
  ".scss"
])
const HASH_EXTS = new Set([".py", ".sh", ".bash", ".zsh", ".rb", ".yaml", ".yml", ".toml", ".r"])
const DASH_EXTS = new Set([".sql", ".lua", ".hs"])
const MARKUP_EXTS = new Set([".html", ".xml", ".svg"])
const JS_REGEX_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vibe"])

/**
 * Detects the comment LanguageFamily for a file path, or undefined if unsupported.
 *
 * @since 1.0.0
 * @category lexing
 */
export const detectLanguage = (filePath: string): LanguageFamily | undefined => {
  const ext = Path.extname(filePath).toLowerCase()
  if (C_STYLE_EXTS.has(ext)) return "c-style"
  if (HASH_EXTS.has(ext)) return "hash"
  if (DASH_EXTS.has(ext)) return "dash"
  if (MARKUP_EXTS.has(ext)) return "markup"
  return undefined
}

/**
 * True when a c-style file supports `//` line comments (false for plain CSS).
 *
 * @since 1.0.0
 * @category lexing
 */
export const hasLineComments = (filePath: string): boolean => Path.extname(filePath).toLowerCase() !== ".css"

const BUILTIN_PRAGMA_RE =
  /SPDX-License-Identifier:|Copyright\s+|@ts-(?:ignore|expect-error|nocheck|check)\b|^\/\/\/\s*<reference\b|sourceMappingURL=|webpackChunkName|@vite-ignore\b|\beslint-(?:disable|enable|env)\b|\bprettier-ignore\b|\bbiome-ignore\b|\bdprint-ignore\b|\boxlint-disable\b|\b(?:v8|c8|istanbul)\s+ignore\b|\bpragma:\s*no\s+cover\b|\bnoqa\b|\btype:\s*ignore\b|\bpyright:|\bmypy:|\bpylint:|\bfmt:\s*(?:off|on)\b|\bcoding[:=]\s*[-\w.]+|\bgo:(?:generate|embed|build)\b|^\s*\+build\b|\bnolint\b|\bclippy::|\brustfmt::skip\b|^\s*#?(?:end)?region\b/i

/**
 * Reports whether a comment must stay in source code as a compiler, linter, or license pragma.
 *
 * @since 1.0.0
 * @category lexing
 */
export const isPragmaComment = (
  raw: string,
  body: string,
  startLine: number,
  extraPatterns?: ReadonlyArray<RegExp>
): boolean => {
  if (startLine === 1 && raw.startsWith("#!")) return true
  if (BUILTIN_PRAGMA_RE.test(raw) || BUILTIN_PRAGMA_RE.test(body)) return true
  if (extraPatterns !== undefined) {
    for (const re of extraPatterns) {
      re.lastIndex = 0
      if (re.test(raw)) return true
      re.lastIndex = 0
      if (re.test(body)) return true
    }
  }
  return false
}

const buildLineStarts = (source: string): Array<number> => {
  const starts: Array<number> = [0]
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i)
    if (c === 10) {
      starts.push(i + 1)
    } else if (c === 13 && source.charCodeAt(i + 1) !== 10) {
      starts.push(i + 1)
    }
  }
  return starts
}

const offsetToLineCol = (
  lineStarts: ReadonlyArray<number>,
  offset: number
): { readonly line: number; readonly col: number } => {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, col: offset - lineStarts[lo]! + 1 }
}

const lineTextAt = (source: string, lineStarts: ReadonlyArray<number>, line: number): string => {
  const start = lineStarts[line - 1] ?? 0
  let end = line < lineStarts.length ? lineStarts[line]! : source.length
  if (end > start && source.charCodeAt(end - 1) === 10) end--
  if (end > start && source.charCodeAt(end - 1) === 13) end--
  return source.slice(start, end)
}

const cleanCommentBody = (raw: string, style: CommentStyle, language: LanguageFamily): string => {
  if (language === "markup") {
    const inner = raw.replace(/^<!--/, "").replace(/-->$/, "")
    return inner.split(/\r?\n/).map((l) => l.trim()).join("\n").trim()
  }
  if (language === "hash") {
    return raw.startsWith("#!") ? raw.slice(2).trim() : raw.slice(1).trim()
  }
  if (language === "dash") {
    return raw.slice(2).trim()
  }
  if (style === "line") {
    return raw.startsWith("#!") ? raw.slice(2).trim() : raw.slice(2).trim()
  }
  const openLen = style === "doc" && raw.charCodeAt(3) !== 47 ? 3 : 2
  const closeLen = raw.endsWith("*/") && raw.length >= openLen + 2 ? 2 : 0
  const inner = raw.slice(openLen, closeLen > 0 ? raw.length - closeLen : raw.length)
  const lines = inner.split(/\r?\n/).map((line) => line.replace(/^\s*\* ?/, "").trimEnd())
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
  return lines.map((l) => l.trim()).join("\n").trim()
}

interface RawSpan {
  readonly style: CommentStyle
  readonly start: number
  readonly end: number
}

const REGEX_PRECEDER_CODES = new Set(
  "(=,:![&|?{};~^+-*%<>".split("").map((c) => c.charCodeAt(0))
)
const REGEX_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "typeof",
  "void",
  "delete",
  "in",
  "of",
  "yield",
  "await",
  "new",
  "else",
  "do"
])

const isIdentChar = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 36

const canStartRegex = (source: string, slashIndex: number): boolean => {
  let i = slashIndex - 1
  while (i >= 0) {
    const c = source.charCodeAt(i)
    if (c === 32 || c === 9 || c === 13 || c === 10) i--
    else break
  }
  if (i < 0) return true
  const ch = source.charCodeAt(i)
  if (REGEX_PRECEDER_CODES.has(ch)) return true
  if (isIdentChar(ch)) {
    let j = i
    while (j >= 0 && isIdentChar(source.charCodeAt(j))) j--
    return REGEX_KEYWORDS.has(source.slice(j + 1, i + 1))
  }
  return false
}

const scanCStyle = (source: string, filePath: string): Array<RawSpan> => {
  const spans: Array<RawSpan> = []
  const ext = Path.extname(filePath).toLowerCase()
  const isRust = ext === ".rs"
  const isGo = ext === ".go"
  const isCss = ext === ".css"
  const supportsJsRegex = JS_REGEX_EXTS.has(ext)
  const n = source.length
  let i = 0

  // Line-1 shebang
  if (n >= 2 && source.charCodeAt(0) === 35 && source.charCodeAt(1) === 33) {
    let end = 2
    while (end < n && source.charCodeAt(end) !== 10 && source.charCodeAt(end) !== 13) end++
    spans.push({ style: "line", start: 0, end })
    i = end
  }

  const templateBraceDepths: Array<number> = []

  while (i < n) {
    const c = source.charCodeAt(i)

    // Template literal `${ ... }` exit
    if (c === 125 && templateBraceDepths.length > 0) {
      const top = templateBraceDepths[templateBraceDepths.length - 1]!
      if (top === 0) {
        templateBraceDepths.pop()
        i++
        while (i < n) {
          const tc = source.charCodeAt(i)
          if (tc === 92) {
            i += 2
            continue
          }
          if (tc === 96) {
            i++
            break
          }
          if (tc === 36 && i + 1 < n && source.charCodeAt(i + 1) === 123) {
            templateBraceDepths.push(0)
            i += 2
            break
          }
          i++
        }
        continue
      }
      templateBraceDepths[templateBraceDepths.length - 1] = top - 1
      i++
      continue
    }

    if (c === 123 && templateBraceDepths.length > 0) {
      templateBraceDepths[templateBraceDepths.length - 1] = templateBraceDepths[templateBraceDepths.length - 1]! + 1
      i++
      continue
    }

    // Rust raw strings r#"..."# and br#"..."#
    if (isRust && (c === 114 || (c === 98 && i + 1 < n && source.charCodeAt(i + 1) === 114))) {
      let j = c === 98 ? i + 2 : i + 1
      let hashes = 0
      while (j < n && source.charCodeAt(j) === 35) {
        hashes++
        j++
      }
      if (j < n && source.charCodeAt(j) === 34) {
        j++
        while (j < n) {
          if (source.charCodeAt(j) === 34) {
            let k = j + 1
            let matched = 0
            while (matched < hashes && k < n && source.charCodeAt(k) === 35) {
              matched++
              k++
            }
            if (matched === hashes) {
              j = k
              break
            }
          }
          j++
        }
        i = j
        continue
      }
    }

    // Double / single quotes
    if (c === 34 || c === 39) {
      if (isRust && c === 39) {
        if (i + 2 < n && source.charCodeAt(i + 1) !== 92 && source.charCodeAt(i + 2) === 39) {
          i += 3
          continue
        }
        if (i + 3 < n && source.charCodeAt(i + 1) === 92 && source.charCodeAt(i + 3) === 39) {
          i += 4
          continue
        }
        i++
        continue
      }
      const quote = c
      i++
      while (i < n) {
        const sc = source.charCodeAt(i)
        if (sc === 92) {
          i += 2
          continue
        }
        if (sc === quote || sc === 10) {
          i++
          break
        }
        i++
      }
      continue
    }

    // Backtick template / raw string
    if (c === 96) {
      i++
      if (isGo) {
        while (i < n && source.charCodeAt(i) !== 96) i++
        if (i < n) i++
        continue
      }
      while (i < n) {
        const tc = source.charCodeAt(i)
        if (tc === 92) {
          i += 2
          continue
        }
        if (tc === 96) {
          i++
          break
        }
        if (tc === 36 && i + 1 < n && source.charCodeAt(i + 1) === 123) {
          templateBraceDepths.push(0)
          i += 2
          break
        }
        i++
      }
      continue
    }

    // Comments or JS regex starting with `/`
    if (c === 47 && i + 1 < n) {
      const next = source.charCodeAt(i + 1)
      if (!isCss && next === 47) {
        const start = i
        i += 2
        while (i < n && source.charCodeAt(i) !== 10 && source.charCodeAt(i) !== 13) i++
        spans.push({ style: "line", start, end: i })
        continue
      }
      if (next === 42) {
        const start = i
        const isDoc = i + 2 < n && source.charCodeAt(i + 2) === 42 && !(i + 3 < n && source.charCodeAt(i + 3) === 47)
        i += 2
        let depth = 1
        while (i < n && depth > 0) {
          if (isRust && source.charCodeAt(i) === 47 && i + 1 < n && source.charCodeAt(i + 1) === 42) {
            depth++
            i += 2
            continue
          }
          if (source.charCodeAt(i) === 42 && i + 1 < n && source.charCodeAt(i + 1) === 47) {
            depth--
            i += 2
            continue
          }
          i++
        }
        spans.push({ style: isDoc ? "doc" : "block", start, end: i })
        continue
      }
      if (supportsJsRegex && canStartRegex(source, i)) {
        let j = i + 1
        let inClass = false
        let valid = false
        while (j < n && source.charCodeAt(j) !== 10 && source.charCodeAt(j) !== 13) {
          const rc = source.charCodeAt(j)
          if (rc === 92) {
            j += 2
            continue
          }
          if (rc === 91) inClass = true
          else if (rc === 93) inClass = false
          else if (rc === 47 && !inClass) {
            j++
            while (
              j < n &&
              ((source.charCodeAt(j) >= 65 && source.charCodeAt(j) <= 90) ||
                (source.charCodeAt(j) >= 97 && source.charCodeAt(j) <= 122))
            ) {
              j++
            }
            valid = true
            break
          }
          j++
        }
        if (valid) {
          i = j
          continue
        }
      }
    }

    i++
  }

  return spans
}

const scanHash = (source: string): Array<RawSpan> => {
  const spans: Array<RawSpan> = []
  const n = source.length
  let i = 0
  while (i < n) {
    const c = source.charCodeAt(i)
    if ((c === 34 || c === 39) && i + 2 < n && source.charCodeAt(i + 1) === c && source.charCodeAt(i + 2) === c) {
      i += 3
      while (i < n) {
        if (source.charCodeAt(i) === 92) {
          i += 2
          continue
        }
        if (
          source.charCodeAt(i) === c && i + 2 < n && source.charCodeAt(i + 1) === c && source.charCodeAt(i + 2) === c
        ) {
          i += 3
          break
        }
        i++
      }
      continue
    }
    if (c === 34 || c === 39) {
      i++
      while (i < n) {
        const sc = source.charCodeAt(i)
        if (sc === 92) {
          i += 2
          continue
        }
        if (sc === c || sc === 10) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === 35) {
      const start = i
      i++
      while (i < n && source.charCodeAt(i) !== 10 && source.charCodeAt(i) !== 13) i++
      spans.push({ style: "line", start, end: i })
      continue
    }
    i++
  }
  return spans
}

const scanDash = (source: string): Array<RawSpan> => {
  const spans: Array<RawSpan> = []
  const n = source.length
  let i = 0
  while (i < n) {
    const c = source.charCodeAt(i)
    if (c === 39 || c === 34) {
      i++
      while (i < n) {
        const sc = source.charCodeAt(i)
        if (sc === c) {
          if (i + 1 < n && source.charCodeAt(i + 1) === c) {
            i += 2
            continue
          }
          i++
          break
        }
        if (sc === 92) {
          i += 2
          continue
        }
        i++
      }
      continue
    }
    if (c === 45 && i + 1 < n && source.charCodeAt(i + 1) === 45) {
      const start = i
      i += 2
      while (i < n && source.charCodeAt(i) !== 10 && source.charCodeAt(i) !== 13) i++
      spans.push({ style: "line", start, end: i })
      continue
    }
    i++
  }
  return spans
}

const scanMarkup = (source: string): Array<RawSpan> => {
  const spans: Array<RawSpan> = []
  const n = source.length
  let i = 0
  while (i < n) {
    if (source.charCodeAt(i) === 60 && source.startsWith("<!--", i)) {
      const start = i
      const close = source.indexOf("-->", i + 4)
      i = close === -1 ? n : close + 3
      spans.push({ style: "block", start, end: i })
      continue
    }
    i++
  }
  return spans
}

/**
 * Lexes all comments in a source file without misinterpreting strings, templates, or regex literals.
 *
 * @since 1.0.0
 * @category lexing
 */
export const lexComments = (source: string, filePath: string, options?: LexOptions): LexResult => {
  const language: LanguageFamily = detectLanguage(filePath) ?? "c-style"
  const eol = eolOf(source)
  const hasTrailing = trailingNewline(source)
  const lineStarts = buildLineStarts(source)
  const lineCount = hasTrailing ? Math.max(1, lineStarts.length - 1) : lineStarts.length

  if (source.includes("\0")) {
    return { language, comments: [], lineCount, eol, hasTrailingNewline: hasTrailing }
  }

  const extraRes = (options?.extraPragmaPatterns ?? []).flatMap((p) => {
    try {
      return [new RegExp(p)]
    } catch {
      return []
    }
  })

  const rawSpans = language === "c-style"
    ? scanCStyle(source, filePath)
    : language === "hash"
    ? scanHash(source)
    : language === "dash"
    ? scanDash(source)
    : scanMarkup(source)

  const preserve = options?.preservePragmas ?? true
  const comments: Array<LexedComment> = rawSpans.map((span) => {
    const raw = source.slice(span.start, span.end)
    const startPos = offsetToLineCol(lineStarts, span.start)
    const endPos = offsetToLineCol(lineStarts, Math.max(span.start, span.end - 1))
    const linePrefix = source.slice(lineStarts[startPos.line - 1] ?? 0, span.start)
    const isInline = linePrefix.trim().length > 0
    const indentation = leadingIndent(lineTextAt(source, lineStarts, startPos.line))
    const body = cleanCommentBody(raw, span.style, language)
    const isPragma = preserve ? isPragmaComment(raw, body, startPos.line, extraRes) : false

    let anchorLine = startPos.line
    if (!isInline) {
      let candidate = endPos.line + 1
      while (candidate <= lineCount) {
        if (lineTextAt(source, lineStarts, candidate).trim().length > 0) {
          anchorLine = candidate
          break
        }
        candidate++
      }
      if (candidate > lineCount) anchorLine = endPos.line
    }

    return {
      id: `c_${startPos.line}_${startPos.col}`,
      style: span.style,
      raw,
      body,
      startOffset: span.start,
      endOffset: span.end,
      startLine: startPos.line,
      endLine: endPos.line,
      startColumn: startPos.col,
      endColumn: endPos.col,
      isInline,
      isPragma,
      anchorLine,
      indentation
    }
  })

  return { language, comments, lineCount, eol, hasTrailingNewline: hasTrailing }
}

/**
 * Removes non-overlapping comment spans from source, collapsing comment-only lines and preventing token gluing.
 *
 * @since 1.0.0
 * @category lexing
 */
export const removeSpans = (
  source: string,
  spans: ReadonlyArray<{ readonly start: number; readonly end: number }>
): string => {
  if (spans.length === 0) return source
  const sorted = [...spans].sort((a, b) => b.start - a.start)
  let out = source

  for (const span of sorted) {
    const lineStart = out.lastIndexOf("\n", Math.max(0, span.start - 1)) + 1
    let lineEnd = out.indexOf("\n", span.end)
    const hasNl = lineEnd !== -1
    if (lineEnd === -1) lineEnd = out.length

    const beforeOnLine = out.slice(lineStart, span.start)
    const afterOnLine = out.slice(span.end, lineEnd).replace(/\r$/, "")

    if (beforeOnLine.trim() === "" && afterOnLine.trim() === "") {
      out = out.slice(0, lineStart) + out.slice(hasNl ? lineEnd + 1 : lineEnd)
    } else if (afterOnLine.trim() === "") {
      let trimStart = span.start
      while (trimStart > lineStart && (out.charCodeAt(trimStart - 1) === 32 || out.charCodeAt(trimStart - 1) === 9)) {
        trimStart--
      }
      out = out.slice(0, trimStart) + out.slice(span.end)
    } else {
      const leftChar = span.start > 0 ? out[span.start - 1]! : " "
      const rightChar = span.end < out.length ? out[span.end]! : " "
      const glue = !/\s/.test(leftChar) && !/\s/.test(rightChar) ? " " : ""
      out = out.slice(0, span.start) + glue + out.slice(span.end)
    }
  }

  return out
}

/**
 * Strips non-pragma prose comments from source text and returns stripped code plus line mappings.
 *
 * @since 1.0.0
 * @category lexing
 */
export const stripProseComments = (
  source: string,
  filePath: string,
  options?: LexOptions
): {
  readonly code: string
  readonly extracted: ReadonlyArray<LexedComment>
  readonly preservedPragmas: ReadonlyArray<LexedComment>
} => {
  const lexed = lexComments(source, filePath, options)
  const extracted: Array<LexedComment> = []
  const preservedPragmas: Array<LexedComment> = []

  for (const c of lexed.comments) {
    if (c.isPragma) preservedPragmas.push(c)
    else extracted.push(c)
  }

  const code = removeSpans(
    source,
    extracted.map((c) => ({ start: c.startOffset, end: c.endOffset }))
  )
  return { code, extracted, preservedPragmas }
}
