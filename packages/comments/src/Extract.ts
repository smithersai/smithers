/**
 * Extraction of inline prose comments into external Markdown sidecars while preserving compiler pragmas.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Anchor from "./Anchor.ts"
import type { CommentsConfig } from "./Config.ts"
import { atomicWrite, confinedPath, io, isMissing, linesOf } from "./internal/FsSafe.ts"
import type { RepositoryError } from "./internal/FsSafe.ts"
import * as Lexer from "./Lexer.ts"
import * as Sidecar from "./Sidecar.ts"

/**
 * Per-file extraction outcome containing stripped code and generated sidecar data.
 *
 * @since 1.0.0
 * @category models
 */
export interface ExtractFileResult {
  readonly sourcePath: string
  readonly sidecarPath: string
  readonly cleanCode: string
  readonly sidecar: Sidecar.SidecarDocument | undefined
  readonly commentsExtracted: number
  readonly pragmasPreserved: number
}

/**
 * Repository-wide summary returned by an extract workflow run.
 *
 * @since 1.0.0
 * @category models
 */
export interface ExtractReport {
  readonly commentsDir: string
  readonly dryRun: boolean
  readonly filesProcessed: number
  readonly commentsExtracted: number
  readonly pragmasPreserved: number
  readonly sidecarsWritten: number
}

const makeStableId = (anchor: Anchor.AnchorSpec, index: number, used: Set<string>): string => {
  const base = anchor.kind === "symbol"
    ? `${anchor.symbol}-comment`
    : anchor.kind === "file"
    ? "file-overview"
    : `c-${String(index + 1).padStart(4, "0")}`
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "c-")
  let candidate = sanitized || `c-${index + 1}`
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${sanitized}-${suffix++}`
  }
  used.add(candidate)
  return candidate
}

/**
 * Extracts non-pragma comments from one source file into a canonical SidecarDocument, adjusting anchor lines accurately.
 *
 * @since 1.0.0
 * @category extraction
 */
export const extractFile = (source: string, relPath: string, config: CommentsConfig): ExtractFileResult => {
  const language: Lexer.LanguageFamily = Lexer.detectLanguage(relPath) ?? "c-style"
  const stripped = Lexer.stripProseComments(source, relPath, {
    preservePragmas: config.preservePragmas,
    extraPragmaPatterns: config.extraPragmaPatterns
  })

  const sidecarPath = Sidecar.sidecarPathFor(config.commentsDir, relPath)
  if (stripped.extracted.length === 0) {
    return {
      sourcePath: relPath,
      sidecarPath,
      cleanCode: source,
      sidecar: undefined,
      commentsExtracted: 0,
      pragmasPreserved: stripped.preservedPragmas.length
    }
  }

  // Track whole lines removed so anchorLine maps accurately into stripped.code
  const origLines = linesOf(source)
  const removedLines = new Set<number>()
  for (const c of stripped.extracted) {
    if (!c.isInline) {
      const startLine = origLines[c.startLine - 1] ?? ""
      const endLine = origLines[c.endLine - 1] ?? ""
      const rawLines = c.raw.replace(/\r\n?/g, "\n").split("\n")
      if (startLine.trim() === rawLines[0]!.trim() && endLine.trim() === rawLines[rawLines.length - 1]!.trim()) {
        for (let ln = c.startLine; ln <= c.endLine; ln++) removedLines.add(ln)
      }
    }
  }

  const cleanIndex = Anchor.indexSource(stripped.code, language)
  const usedIds = new Set<string>()

  const entries: Array<Sidecar.SidecarEntry> = stripped.extracted.map((c, idx) => {
    let shift = 0
    for (const rln of removedLines) {
      if (rln < c.anchorLine) shift++
    }
    const adjusted: Lexer.LexedComment = { ...c, anchorLine: Math.max(1, c.anchorLine - shift) }
    const inferred = Anchor.inferAnchorIndexed(cleanIndex, adjusted)
    const id = makeStableId(inferred.anchor, idx, usedIds)
    return {
      id,
      anchor: inferred.anchor,
      ...(inferred.anchor.kind === "symbol" || inferred.anchor.kind === "pattern" ? { line: inferred.line } : {}),
      placement: inferred.placement,
      style: c.style,
      codeHash: inferred.codeHash,
      body: c.body
    }
  })

  return {
    sourcePath: relPath,
    sidecarPath,
    cleanCode: stripped.code,
    sidecar: { source: relPath, version: 1, entries },
    commentsExtracted: entries.length,
    pragmasPreserved: stripped.preservedPragmas.length
  }
}

/**
 * Merges extracted entries into any existing sidecar and writes sidecar + stripped source atomically with rollback.
 *
 * @since 1.0.0
 * @category extraction
 */
export const writeExtractedFile = (
  cwd: string,
  result: ExtractFileResult,
  existingSidecar: Sidecar.SidecarDocument | undefined,
  dryRun: boolean
): Effect.Effect<boolean, RepositoryError> =>
  Effect.gen(function*() {
    if (result.sidecar === undefined) return false

    const usedIds = new Set(existingSidecar?.entries.map((e) => e.id))
    const mergedNew = result.sidecar.entries.map((entry) => {
      let id = entry.id
      let suffix = 2
      while (usedIds.has(id)) id = `${entry.id}-${suffix++}`
      usedIds.add(id)
      return { ...entry, id }
    })
    const finalDoc: Sidecar.SidecarDocument = {
      source: result.sourcePath,
      version: 1,
      entries: [...(existingSidecar?.entries ?? []), ...mergedNew]
    }

    if (dryRun) return true

    yield* io("extract", result.sourcePath, async () => {
      const absSource = await confinedPath(cwd, result.sourcePath)
      const absSidecar = await confinedPath(cwd, result.sidecarPath)
      const prevSidecarRaw = await Fs.readFile(absSidecar, "utf8").catch((cause: unknown) => {
        if (isMissing(cause)) return undefined
        throw cause
      })
      await atomicWrite(absSidecar, Sidecar.formatSidecar(finalDoc))
      try {
        await atomicWrite(absSource, result.cleanCode)
      } catch (err) {
        if (prevSidecarRaw === undefined) await Fs.rm(absSidecar, { force: true })
        else await atomicWrite(absSidecar, prevSidecarRaw)
        throw err
      }
    })
    return true
  })
