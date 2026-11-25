/**
 * Pure virtual file projection, deterministic tree hashing, and atomic disk materialization with drift checks.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import { indexSource, resolveAnchorIndexed } from "./Anchor.ts"
import {
  atomicWrite,
  compare,
  confinedPath,
  eolOf,
  isMissing,
  leadingIndent,
  posix,
  sha256,
  trailingNewline
} from "./internal/FsSafe.ts"
import { detectLanguage, hasLineComments } from "./Lexer.ts"
import type { CommentStyle, LanguageFamily } from "./Lexer.ts"
import { formatSidecar } from "./Sidecar.ts"
import type { Placement, SidecarDocument, SidecarEntry } from "./Sidecar.ts"

/**
 * Mapping from an injected virtual comment span back to its source anchor line.
 *
 * @since 1.0.0
 * @category models
 */
export interface VirtualLineMapping {
  readonly commentId: string
  readonly virtualStartLine: number
  readonly virtualEndLine: number
  readonly anchorLine: number
}

/**
 * Projected commented view of a single source file with deterministic SHA-256 digest.
 *
 * @since 1.0.0
 * @category models
 */
export interface VirtualFile {
  readonly path: string
  readonly content: string
  readonly digest: string
  readonly sourceDigest: string
  readonly commentsDigest: string
  readonly injectedCount: number
  readonly lineMap: ReadonlyArray<VirtualLineMapping>
}

/**
 * Projected tree of virtual commented files with a combined tree digest.
 *
 * @since 1.0.0
 * @category models
 */
export interface VirtualFileTree {
  readonly files: ReadonlyMap<string, VirtualFile>
  readonly treeDigest: string
}

/**
 * Typed failure raised when projecting a sidecar into a virtual file fails.
 *
 * @since 1.0.0
 * @category errors
 */
export class VirtualFileProjectionError extends Schema.TaggedError<VirtualFileProjectionError>()(
  "smithers-comments/VirtualFileProjectionError",
  {
    path: Schema.String,
    commentId: Schema.optional(Schema.String),
    reason: Schema.String,
    message: Schema.String
  }
) {}

/**
 * Options controlling unresolved anchor handling during virtual projection.
 *
 * @since 1.0.0
 * @category models
 */
export interface ProjectOptions {
  readonly onUnresolved?: "fail" | "skip"
}

const prefixLines = (prefix: string, lines: ReadonlyArray<string>): Array<string> =>
  lines.map((l) => (l.length > 0 ? `${prefix} ${l}` : prefix))

/**
 * Renders a comment body in language-native syntax, guarding against embedded closing delimiters.
 *
 * @since 1.0.0
 * @category projection
 */
export const renderCommentLines = (
  filePath: string,
  language: LanguageFamily,
  style: CommentStyle,
  body: string,
  trailing = false
): Array<string> => {
  const lines = body.replace(/\r\n?/g, "\n").split("\n")
  if (language === "hash") return prefixLines("#", lines)
  if (language === "dash") return prefixLines("--", lines)
  if (language === "markup") {
    const safe = lines.map((l) => l.replace(/-->/g, "-- >"))
    return safe.length === 1 ? [`<!-- ${safe[0]!} -->`] : ["<!--", ...safe.map((l) => (l ? `  ${l}` : "")), "-->"]
  }
  const allowLine = hasLineComments(filePath)
  const hasClose = body.includes("*/")
  if (allowLine && (style === "line" || hasClose)) {
    return prefixLines("//", lines)
  }
  const safe = hasClose ? lines.map((l) => l.replace(/\*\//g, "* /")) : lines
  const open = style === "doc" ? "/**" : "/*"
  if (safe.length === 1 && (trailing || style === "block")) {
    return [`${open} ${safe[0]!} */`.replace("  */", " */")]
  }
  return [open, ...prefixLines(" *", safe), " */"]
}

/**
 * Synchronous result union returned by projectFileSync.
 *
 * @since 1.0.0
 * @category models
 */
export type SyncProjection =
  | { readonly ok: true; readonly file: VirtualFile }
  | { readonly ok: false; readonly error: VirtualFileProjectionError }

/**
 * Pure synchronous virtual projection backed by a single-pass SourceIndex.
 *
 * @since 1.0.0
 * @category projection
 */
export const projectFileSync = (
  source: string,
  sidecar: SidecarDocument | undefined,
  filePath: string,
  options?: ProjectOptions
): SyncProjection => {
  const path = posix(filePath)
  const sourceDigest = sha256(source)
  const commentsDigest = sidecar === undefined ? "" : sha256(formatSidecar(sidecar))

  const emptyProjection = (): SyncProjection => ({
    ok: true,
    file: {
      path,
      content: source,
      digest: sourceDigest,
      sourceDigest,
      commentsDigest,
      injectedCount: 0,
      lineMap: []
    }
  })

  if (sidecar === undefined || sidecar.entries.length === 0) return emptyProjection()

  const language: LanguageFamily = detectLanguage(filePath) ?? "c-style"
  const index = indexSource(source, language)
  const lines = index.lines
  const onUnresolved = options?.onUnresolved ?? "fail"

  const groups = new Map<
    number,
    { before: Array<SidecarEntry>; inline: Array<SidecarEntry>; after: Array<SidecarEntry> }
  >()
  let injectedCount = 0

  for (const entry of sidecar.entries) {
    const resolved = resolveAnchorIndexed(index, entry.anchor, entry.placement, entry.line)
    if (!resolved.ok) {
      if (onUnresolved === "skip") continue
      return {
        ok: false,
        error: new VirtualFileProjectionError({
          path,
          commentId: entry.id,
          reason: resolved.reason,
          message: `${path} (@${entry.id}): ${resolved.message}`
        })
      }
    }

    const anchorLine = Math.max(1, Math.min(resolved.anchor.line, lines.length))
    const fitsInline = entry.placement === "inline" &&
      entry.anchor.kind !== "file" &&
      !entry.body.includes("\n") &&
      entry.style !== "doc"
    const effectivePlacement: Placement = entry.placement === "inline"
      ? (fitsInline ? "inline" : "before")
      : entry.placement

    let group = groups.get(anchorLine)
    if (group === undefined) {
      group = { before: [], inline: [], after: [] }
      groups.set(anchorLine, group)
    }
    group[effectivePlacement].push(entry)
    injectedCount++
  }

  if (injectedCount === 0) return emptyProjection()

  const sortBucket = (bucket: Array<SidecarEntry>): void => {
    bucket.sort((a, b) => {
      const af = a.anchor.kind === "file" ? 0 : 1
      const bf = b.anchor.kind === "file" ? 0 : 1
      return af - bf || compare(a.id, b.id)
    })
  }

  const outLines: Array<string> = []
  const lineMap: Array<VirtualLineMapping> = []
  const eol = eolOf(source)
  const hasTrailing = trailingNewline(source)

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1
    const codeLine = lines[i]!
    const indent = leadingIndent(codeLine)
    const group = groups.get(lineNum)

    if (group !== undefined) {
      sortBucket(group.before)
      for (const entry of group.before) {
        const rendered = renderCommentLines(filePath, language, entry.style, entry.body, false)
        const startLine = outLines.length + 1
        for (const rl of rendered) outLines.push(indent + rl)
        lineMap.push({
          commentId: entry.id,
          virtualStartLine: startLine,
          virtualEndLine: outLines.length,
          anchorLine: lineNum
        })
      }
    }

    let renderedCode = codeLine
    const codeOutLine = outLines.length + 1
    if (group !== undefined && group.inline.length > 0) {
      sortBucket(group.inline)
      for (const entry of group.inline) {
        const suffix = renderCommentLines(filePath, language, entry.style, entry.body, true)[0] ?? ""
        renderedCode += `  ${suffix}`
        lineMap.push({
          commentId: entry.id,
          virtualStartLine: codeOutLine,
          virtualEndLine: codeOutLine,
          anchorLine: lineNum
        })
      }
    }
    outLines.push(renderedCode)

    if (group !== undefined && group.after.length > 0) {
      sortBucket(group.after)
      for (const entry of group.after) {
        const rendered = renderCommentLines(filePath, language, entry.style, entry.body, false)
        const startLine = outLines.length + 1
        for (const rl of rendered) outLines.push(indent + rl)
        lineMap.push({
          commentId: entry.id,
          virtualStartLine: startLine,
          virtualEndLine: outLines.length,
          anchorLine: lineNum
        })
      }
    }
  }

  const content = outLines.join(eol) + (hasTrailing ? eol : "")
  return {
    ok: true,
    file: {
      path,
      content,
      digest: sha256(content),
      sourceDigest,
      commentsDigest,
      injectedCount,
      lineMap
    }
  }
}

/**
 * Projects one source file and optional sidecar into a VirtualFile as an Effect.
 *
 * @since 1.0.0
 * @category projection
 */
export const projectFile = (
  source: string,
  sidecar: SidecarDocument | undefined,
  filePath: string,
  options?: ProjectOptions
): Effect.Effect<VirtualFile, VirtualFileProjectionError> =>
  Effect.suspend(() => {
    const res = projectFileSync(source, sidecar, filePath, options)
    return res.ok ? Effect.succeed(res.file) : Effect.fail(res.error)
  })

/**
 * Projects a map of clean sources and sidecars into a deterministic VirtualFileTree.
 *
 * @since 1.0.0
 * @category projection
 */
export const projectTree = (
  sources: ReadonlyMap<string, string>,
  sidecars: ReadonlyMap<string, SidecarDocument>,
  options?: ProjectOptions
): Effect.Effect<VirtualFileTree, VirtualFileProjectionError> =>
  Effect.gen(function*() {
    const sortedPaths = [...sources.keys()].sort(compare)
    const files = new Map<string, VirtualFile>()
    const digestParts: Array<string> = []

    for (const relPath of sortedPaths) {
      const vf = yield* projectFile(sources.get(relPath)!, sidecars.get(relPath), relPath, options)
      files.set(relPath, vf)
      digestParts.push(`${relPath}:${vf.digest}\n`)
    }

    return {
      files,
      treeDigest: sha256(digestParts.join(""))
    }
  })

/**
 * Atomically materializes a VirtualFileTree to disk or checks an output directory for drift.
 *
 * @since 1.0.0
 * @category projection
 */
export const materializeTree = (
  tree: VirtualFileTree,
  outDir: string,
  options?: { readonly check?: boolean }
): Effect.Effect<
  { readonly written: ReadonlyArray<string>; readonly drifted: ReadonlyArray<string> },
  VirtualFileProjectionError
> =>
  Effect.tryPromise({
    try: async () => {
      const checkOnly = options?.check ?? false
      const written: Array<string> = []
      const drifted: Array<string> = []

      for (const [relPath, vf] of tree.files) {
        const dest = await confinedPath(outDir, relPath)
        const existing = await Fs.readFile(dest, "utf8").catch((cause: unknown) => {
          if (isMissing(cause)) return undefined
          throw cause
        })
        if (existing === vf.content) continue
        if (checkOnly) {
          drifted.push(relPath)
        } else {
          await atomicWrite(dest, vf.content)
          written.push(relPath)
        }
      }

      return { written, drifted }
    },
    catch: (cause) =>
      new VirtualFileProjectionError({
        path: outDir,
        reason: "io-error",
        message: `Failed materializing virtual tree to ${outDir}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      })
  })
