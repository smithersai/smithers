/**
 * Strict Markdown sidecar parser, canonical formatter, sorting, and path mapping helpers.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { AnchorSpec, Placement } from "./Anchor.ts"
import { compare, posix, safeRelative } from "./internal/FsSafe.ts"
import type { CommentStyle } from "./Lexer.ts"

export type { Placement } from "./Anchor.ts"

/**
 * Single external comment entry stored in a Markdown sidecar file.
 *
 * @since 1.0.0
 * @category models
 */
export interface SidecarEntry {
  readonly id: string
  readonly anchor: AnchorSpec
  readonly line?: number
  readonly placement: Placement
  readonly style: CommentStyle
  readonly codeHash?: string
  readonly body: string
}

/**
 * Parsed external Markdown sidecar document bound to one source file.
 *
 * @since 1.0.0
 * @category models
 */
export interface SidecarDocument {
  readonly source: string
  readonly version: 1
  readonly entries: ReadonlyArray<SidecarEntry>
}

/**
 * Typed failure raised when a Markdown sidecar violates the sidecar grammar.
 *
 * @since 1.0.0
 * @category errors
 */
export class SidecarParseError extends Schema.TaggedError<SidecarParseError>()(
  "smithers-comments/SidecarParseError",
  {
    filePath: Schema.optional(Schema.String),
    message: Schema.String
  }
) {}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CODE_HASH_RE = /^[0-9a-f]{8}$/
const POSITIVE_INT_RE = /^[1-9]\d*$/

/**
 * Computes the repository-relative sidecar Markdown path for a source file.
 *
 * @since 1.0.0
 * @category sidecar
 */
export const sidecarPathFor = (commentsDir: string, sourceRelPath: string): string => {
  if (!safeRelative(commentsDir) || !safeRelative(sourceRelPath)) {
    throw new RangeError(`Sidecar path must remain inside repository: ${commentsDir} / ${sourceRelPath}`)
  }
  return `${posix(commentsDir)}/${posix(sourceRelPath)}.md`
}

/**
 * Recovers the source file path from a sidecar path inside commentsDir.
 *
 * @since 1.0.0
 * @category sidecar
 */
export const sourcePathFromSidecar = (commentsDir: string, sidecarRelPath: string): string | undefined => {
  const prefix = `${posix(commentsDir)}/`
  const norm = posix(sidecarRelPath)
  if (!norm.startsWith(prefix) || !norm.endsWith(".md")) return undefined
  const inner = norm.slice(prefix.length, -3)
  return safeRelative(inner) ? inner : undefined
}

const parsePositiveInt = (raw: string, label: string): number => {
  if (!POSITIVE_INT_RE.test(raw)) throw new Error(`Invalid ${label}: ${raw}`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${label}: ${raw}`)
  return n
}

const parseAnchorHeader = (raw: string): AnchorSpec => {
  const value = raw.trim()
  if (value === "file") return { kind: "file" }
  if (value.startsWith("symbol ")) {
    const symbol = value.slice(7).trim()
    if (symbol.length === 0) throw new Error("Empty symbol anchor")
    return { kind: "symbol", symbol }
  }
  if (value.startsWith("line ")) {
    return { kind: "line", line: parsePositiveInt(value.slice(5).trim(), "line anchor") }
  }
  if (value.startsWith("pattern ")) {
    const pattern = value.slice(8)
    if (pattern.length === 0) throw new Error("Empty pattern anchor")
    return { kind: "pattern", pattern }
  }
  throw new Error(`Unsupported anchor syntax: ${value}`)
}

const formatAnchorHeader = (anchor: AnchorSpec): string => {
  switch (anchor.kind) {
    case "file":
      return "file"
    case "symbol":
      return `symbol ${anchor.symbol}`
    case "line":
      return `line ${anchor.line}`
    case "pattern":
      return `pattern ${anchor.pattern}`
  }
}

/**
 * Parses a Markdown sidecar document strictly into a SidecarDocument.
 *
 * @since 1.0.0
 * @category sidecar
 */
export const parseSidecar = (
  content: string,
  filePath?: string
): Effect.Effect<SidecarDocument, SidecarParseError> =>
  Effect.try({
    try: () => {
      const lines = content.replace(/\r\n?/g, "\n").split("\n")
      let i = 0

      if (lines[i++] !== "---") {
        throw new Error("Sidecar must start with YAML frontmatter delimiter '---'")
      }

      const readMeta = (terminator: string, allowed: ReadonlyArray<string>): Record<string, string> => {
        const fields: Record<string, string> = Object.create(null) as Record<string, string>
        while (i < lines.length && lines[i] !== terminator) {
          const line = lines[i++]!
          const m = /^([a-z-]+):[ \t]*(.*)$/.exec(line)
          if (m === null || !allowed.includes(m[1]!) || Object.hasOwn(fields, m[1]!)) {
            throw new Error(`Invalid or duplicate metadata line: ${line}`)
          }
          fields[m[1]!] = m[2]!.trimEnd()
        }
        if (i >= lines.length) throw new Error("Unterminated metadata section")
        i++
        return fields
      }

      const fm = readMeta("---", ["source", "version"])
      if (!fm.source || !safeRelative(fm.source)) {
        throw new Error("Frontmatter missing valid relative 'source' field")
      }
      if (fm.version !== "1") {
        throw new Error(`Unsupported sidecar version '${fm.version ?? ""}' (expected 1)`)
      }

      const entries: Array<SidecarEntry> = []
      const seenIds = new Set<string>()

      while (i < lines.length) {
        if (lines[i] === "") {
          i++
          continue
        }
        const heading = lines[i++]!
        if (!heading.startsWith("## @")) {
          throw new Error(`Unexpected content outside comment block: ${heading}`)
        }
        const id = heading.slice(4).trim()
        if (!ID_RE.test(id)) throw new Error(`Invalid comment ID: ${id}`)
        if (seenIds.has(id)) throw new Error(`Duplicate comment ID: ${id}`)
        seenIds.add(id)

        const meta = readMeta("", ["anchor", "line", "placement", "style", "code-hash"])
        if (!meta.anchor) throw new Error(`Missing 'anchor' in @${id}`)
        const anchor = parseAnchorHeader(meta.anchor)
        const placement = meta.placement
        if (placement !== "before" && placement !== "inline" && placement !== "after") {
          throw new Error(`Invalid placement '${placement ?? ""}' in @${id}`)
        }
        const style = meta.style
        if (style !== "line" && style !== "block" && style !== "doc") {
          throw new Error(`Invalid style '${style ?? ""}' in @${id}`)
        }
        const codeHash = meta["code-hash"]
        if (codeHash !== undefined && !CODE_HASH_RE.test(codeHash)) {
          throw new Error(`Invalid code-hash '${codeHash}' in @${id}`)
        }
        const lineHint = meta.line === undefined ? undefined : parsePositiveInt(meta.line, `line hint in @${id}`)

        const bodyLines: Array<string> = []
        while (i < lines.length && !lines[i]!.startsWith("## @")) {
          bodyLines.push(lines[i++]!.replace(/^(\\+)## @/, (_m, slashes: string) => `${slashes.slice(1)}## @`))
        }
        while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") bodyLines.pop()

        entries.push({
          id,
          anchor,
          ...(lineHint !== undefined ? { line: lineHint } : {}),
          placement,
          style,
          ...(codeHash !== undefined ? { codeHash } : {}),
          body: bodyLines.join("\n")
        })
      }

      return { source: fm.source, version: 1 as const, entries }
    },
    catch: (cause) =>
      new SidecarParseError({
        ...(filePath !== undefined ? { filePath } : {}),
        message: cause instanceof Error ? cause.message : String(cause)
      })
  })

const PLACEMENT_ORDER: Record<Placement, number> = { before: 0, inline: 1, after: 2 }

/**
 * Orders entries canonically by (resolvedLine, placementOrder, id).
 *
 * @since 1.0.0
 * @category sidecar
 */
export const sortEntries = (
  entries: ReadonlyArray<SidecarEntry>,
  resolveLine: (entry: SidecarEntry) => number
): Array<SidecarEntry> =>
  [...entries].sort((a, b) => {
    const lineDiff = resolveLine(a) - resolveLine(b)
    if (lineDiff !== 0) return lineDiff
    const pDiff = PLACEMENT_ORDER[a.placement] - PLACEMENT_ORDER[b.placement]
    if (pDiff !== 0) return pDiff
    return compare(a.id, b.id)
  })

/**
 * Formats a SidecarDocument into canonical Markdown with lossless escaping.
 *
 * @since 1.0.0
 * @category sidecar
 */
export const formatSidecar = (doc: SidecarDocument): string => {
  const blocks = doc.entries.map((entry) => {
    const headerLines = [
      `## @${entry.id}`,
      `anchor: ${formatAnchorHeader(entry.anchor)}`,
      ...(entry.line !== undefined ? [`line: ${entry.line}`] : []),
      `placement: ${entry.placement}`,
      `style: ${entry.style}`,
      ...(entry.codeHash !== undefined ? [`code-hash: ${entry.codeHash}`] : []),
      ""
    ]
    const escapedBody = entry.body
      .replace(/\r\n?/g, "\n")
      .replace(/^(\\*)## @/gm, "\\$1## @")
      .replace(/\n+$/, "")
    return [...headerLines, escapedBody].join("\n")
  })
  return `---\nsource: ${doc.source}\nversion: 1\n---\n${blocks.length > 0 ? `\n${blocks.join("\n\n")}\n` : ""}`
}
