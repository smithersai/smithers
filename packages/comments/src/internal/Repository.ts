/**
 * Internal repository source discovery, sidecar loading, extract, render, and status workflows.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import * as Cache from "../Cache.ts"
import type * as Config from "../Config.ts"
import * as Extract from "../Extract.ts"
import * as Lexer from "../Lexer.ts"
import * as Sidecar from "../Sidecar.ts"
import * as Validator from "../Validator.ts"
import * as VirtualFile from "../VirtualFile.ts"
import * as DocTags from "./DocTags.ts"
import { atomicWrite, compare, confinedPath, io, isMissing, posix, safeRelative } from "./FsSafe.ts"
import type { RepositoryError } from "./FsSafe.ts"

/**
 * @since 1.0.0
 * @private
 */
export interface RenderReport {
  readonly filesRendered: number
  readonly commentsInjected: number
  readonly treeDigest: string
  readonly outDir: string | undefined
  readonly driftedFiles: ReadonlyArray<string>
}

/**
 * @since 1.0.0
 * @private
 */
export interface StatusReport {
  readonly mode: Config.Mode
  readonly commentsDir: string
  readonly configPath: string
  readonly configExists: boolean
  readonly sourceFiles: number
  readonly sidecarFiles: number
  readonly inlineComments: number
  readonly externalComments: number
  readonly pragmasPreserved: number
  readonly cacheEntries: number
  readonly cachePath: string
}

const matchesAnyGlob = (relPath: string, globs: ReadonlyArray<string>): boolean =>
  globs.some((pattern) => Path.matchesGlob(relPath, pattern))

/**
 * @since 1.0.0
 * @private
 */
export const discoverSources = (
  cwd: string,
  config: Config.CommentsConfig,
  explicitPaths?: ReadonlyArray<string>
): Effect.Effect<Map<string, string>, RepositoryError> =>
  io("discover", cwd, async () => {
    const root = Path.resolve(cwd)
    const selectors: Array<string> = []
    for (const rawInput of explicitPaths ?? []) {
      const rel = posix(Path.relative(root, Path.resolve(root, rawInput)))
      if (rel === "") {
        selectors.push("")
        continue
      }
      if (!safeRelative(rel)) throw new Error(`Path escapes repository root: ${rawInput}`)
      const full = await confinedPath(root, rel)
      await Fs.access(full)
      selectors.push(rel)
    }

    const exclude = [...config.exclude, `${config.commentsDir}/**`, `${config.virtualOutDir}/**`, "**/.jj/**"]
    const sources = new Map<string, string>()

    const walk = async (relDir: string): Promise<void> => {
      const absDir = relDir ? Path.join(root, relDir) : root
      const entries = (await Fs.readdir(absDir, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name
        if (matchesAnyGlob(rel, exclude) || matchesAnyGlob(`${rel}/`, exclude)) continue
        if (entry.isDirectory()) {
          await walk(rel)
          continue
        }
        if (!entry.isFile() || Lexer.detectLanguage(rel) === undefined) continue
        if (
          selectors.length > 0
            ? !selectors.some((s) => s === "" || rel === s || rel.startsWith(`${s}/`))
            : !matchesAnyGlob(rel, config.include)
        ) {
          continue
        }
        const text = await Fs.readFile(Path.join(root, rel), "utf8")
        if (!text.includes("\0")) sources.set(rel, text)
      }
    }

    await walk("")
    return sources
  })

/**
 * @since 1.0.0
 * @private
 */
export const loadSidecars = (
  cwd: string,
  config: Config.CommentsConfig,
  sources: ReadonlyMap<string, string>,
  explicitPaths?: ReadonlyArray<string>
): Effect.Effect<
  {
    readonly sidecars: Map<string, Sidecar.SidecarDocument>
    readonly diagnostics: Array<Validator.Diagnostic>
    readonly sidecarFiles: number
  },
  RepositoryError
> =>
  Effect.gen(function*() {
    const sidecarRelPaths = yield* io("discover sidecars", config.commentsDir, async () => {
      const base = await confinedPath(cwd, config.commentsDir)
      const found: Array<string> = []
      const walk = async (dir: string): Promise<void> => {
        let entries
        try {
          entries = await Fs.readdir(dir, { withFileTypes: true })
        } catch (cause) {
          if (isMissing(cause)) return
          throw cause
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue
          const full = Path.join(dir, entry.name)
          if (entry.isDirectory()) await walk(full)
          else if (entry.isFile() && entry.name.endsWith(".md")) {
            found.push(posix(Path.relative(cwd, full)))
          }
        }
      }
      await walk(base)
      return found.sort(compare)
    })

    const sidecars = new Map<string, Sidecar.SidecarDocument>()
    const diagnostics: Array<Validator.Diagnostic> = []

    for (const scRel of sidecarRelPaths) {
      const expectedSource = Sidecar.sourcePathFromSidecar(config.commentsDir, scRel)
      if (explicitPaths && explicitPaths.length > 0 && expectedSource !== undefined && !sources.has(expectedSource)) {
        continue
      }
      const raw = yield* io("read sidecar", scRel, () => Fs.readFile(Path.join(cwd, scRel), "utf8"))
      const parsed = yield* Effect.result(Sidecar.parseSidecar(raw, scRel))
      if (parsed._tag === "Failure") {
        diagnostics.push(Validator.diagnostic(scRel, 1, "malformed-sidecar", parsed.failure.message))
        continue
      }
      const doc = parsed.success
      if (expectedSource !== undefined && doc.source !== expectedSource) {
        diagnostics.push(
          Validator.diagnostic(
            scRel,
            1,
            "malformed-sidecar",
            `Frontmatter source '${doc.source}' does not match path '${expectedSource}'.`
          )
        )
        continue
      }
      const exists = yield* io("stat sidecar source", doc.source, async () => {
        const abs = await confinedPath(cwd, doc.source)
        return await Fs.stat(abs).then(
          (s) => s.isFile(),
          (cause: unknown) => {
            if (isMissing(cause)) return false
            throw cause
          }
        )
      })
      if (!exists) {
        diagnostics.push(
          Validator.diagnostic(scRel, 1, "orphan-sidecar", `Sidecar references missing source file '${doc.source}'.`)
        )
        continue
      }
      sidecars.set(doc.source, doc)
    }

    return { sidecars, diagnostics, sidecarFiles: sidecarRelPaths.length }
  })

/**
 * @since 1.0.0
 * @private
 */
export const collectMissingRefPaths = (
  cwd: string,
  filePath: string,
  comments: ReadonlyArray<{ readonly body: string }>
): Effect.Effect<Set<string>, RepositoryError> =>
  io("check refs", filePath, async () => {
    const missing = new Set<string>()
    const checked = new Set<string>()
    for (const c of comments) {
      for (const ref of DocTags.findRefs(c.body)) {
        if (!DocTags.isPathRef(ref)) continue
        const { path: targetPath } = DocTags.splitPathRef(ref)
        if (checked.has(targetPath)) continue
        checked.add(targetPath)
        const resolved = Path.resolve(cwd, Path.dirname(filePath), targetPath)
        const ok = await Fs.access(resolved).then(() => true, () => false)
        if (!ok) missing.add(targetPath)
      }
    }
    return missing
  })

/**
 * @since 1.0.0
 * @private
 */
export const runExtractRepository = (options: {
  readonly cwd: string
  readonly config: Config.CommentsConfig
  readonly paths?: ReadonlyArray<string>
  readonly dryRun?: boolean
}): Effect.Effect<Extract.ExtractReport, Error> =>
  Effect.gen(function*() {
    const { cwd, config, paths, dryRun = false } = options
    const sources = yield* discoverSources(cwd, config, paths).pipe(Effect.mapError((e) => new Error(e.message)))
    const existing = yield* loadSidecars(cwd, config, sources, paths).pipe(Effect.mapError((e) => new Error(e.message)))
    if (existing.diagnostics.length > 0) {
      return yield* Effect.fail(new Error(`${existing.diagnostics[0]!.code}: ${existing.diagnostics[0]!.message}`))
    }

    let commentsExtracted = 0
    let pragmasPreserved = 0
    let sidecarsWritten = 0

    for (const [relPath, source] of sources) {
      const extracted = Extract.extractFile(source, relPath, config)
      commentsExtracted += extracted.commentsExtracted
      pragmasPreserved += extracted.pragmasPreserved
      const wrote = yield* Extract.writeExtractedFile(cwd, extracted, existing.sidecars.get(relPath), dryRun).pipe(
        Effect.mapError((e) => new Error(e.message))
      )
      if (wrote) sidecarsWritten++
    }

    return {
      commentsDir: config.commentsDir,
      dryRun,
      filesProcessed: sources.size,
      commentsExtracted,
      pragmasPreserved,
      sidecarsWritten
    }
  })

/**
 * @since 1.0.0
 * @private
 */
export const runRenderRepository = (options: {
  readonly cwd: string
  readonly config: Config.CommentsConfig
  readonly paths?: ReadonlyArray<string>
  readonly file?: string
  readonly outDir?: string
  readonly inPlace?: boolean
  readonly removeSidecars?: boolean
  readonly check?: boolean
}): Effect.Effect<{ readonly report: RenderReport; readonly singleFileContent?: string }, Error> =>
  Effect.gen(function*() {
    const { cwd, config, paths, file, outDir, inPlace = false, removeSidecars = false, check = false } = options
    const targetPaths = file !== undefined ? [file] : paths
    const sources = yield* discoverSources(cwd, config, targetPaths).pipe(Effect.mapError((e) => new Error(e.message)))
    if (file !== undefined && sources.size === 0) {
      return yield* Effect.fail(new Error(`Source file not found or unsupported: ${file}`))
    }

    const external = yield* loadSidecars(cwd, config, sources, targetPaths).pipe(
      Effect.mapError((e) => new Error(e.message))
    )
    if (external.diagnostics.length > 0) {
      return yield* Effect.fail(new Error(`${external.diagnostics[0]!.code}: ${external.diagnostics[0]!.message}`))
    }

    const tree = yield* VirtualFile.projectTree(sources, external.sidecars).pipe(
      Effect.mapError((err) => new Error(err.message))
    )

    let commentsInjected = 0
    for (const vf of tree.files.values()) commentsInjected += vf.injectedCount

    if (file !== undefined) {
      const norm = posix(file)
      const vf = tree.files.get(norm) ?? [...tree.files.values()][0]
      return {
        report: {
          filesRendered: tree.files.size,
          commentsInjected,
          treeDigest: tree.treeDigest,
          outDir: undefined,
          driftedFiles: []
        },
        ...(vf !== undefined ? { singleFileContent: vf.content } : {})
      }
    }

    if (outDir !== undefined) {
      const absOut = Path.isAbsolute(outDir) ? outDir : Path.join(cwd, outDir)
      const mat = yield* VirtualFile.materializeTree(tree, absOut, { check }).pipe(
        Effect.mapError((e) => new Error(e.message))
      )
      return {
        report: {
          filesRendered: tree.files.size,
          commentsInjected,
          treeDigest: tree.treeDigest,
          outDir,
          driftedFiles: mat.drifted
        }
      }
    }

    if (inPlace) {
      for (const [relPath, vf] of tree.files) {
        if (vf.injectedCount === 0) continue
        yield* io("render in-place", relPath, async () => atomicWrite(await confinedPath(cwd, relPath), vf.content))
          .pipe(
            Effect.mapError((e) => new Error(e.message))
          )
      }
      if (removeSidecars) {
        for (const relPath of external.sidecars.keys()) {
          const scRel = Sidecar.sidecarPathFor(config.commentsDir, relPath)
          yield* io("remove sidecar", scRel, async () => Fs.rm(await confinedPath(cwd, scRel), { force: true })).pipe(
            Effect.mapError((e) => new Error(e.message))
          )
        }
      }
    }

    return {
      report: {
        filesRendered: tree.files.size,
        commentsInjected,
        treeDigest: tree.treeDigest,
        outDir: undefined,
        driftedFiles: []
      }
    }
  })

/**
 * @since 1.0.0
 * @private
 */
export const runStatusRepository = (options: {
  readonly cwd: string
  readonly config: Config.CommentsConfig
  readonly configPath: string
  readonly configExists: boolean
}): Effect.Effect<StatusReport, Error, Cache.CommentCacheStore> =>
  Effect.gen(function*() {
    const { cwd, config, configPath, configExists } = options
    const cache = yield* Cache.CommentCacheStore
    const sources = yield* discoverSources(cwd, config).pipe(Effect.mapError((e) => new Error(e.message)))
    const external = yield* loadSidecars(cwd, config, sources).pipe(Effect.mapError((e) => new Error(e.message)))

    let inlineComments = 0
    let pragmasPreserved = 0
    for (const [relPath, src] of sources) {
      const lexed = Lexer.lexComments(src, relPath, {
        preservePragmas: config.preservePragmas,
        extraPragmaPatterns: config.extraPragmaPatterns
      })
      for (const c of lexed.comments) {
        if (c.isPragma) pragmasPreserved++
        else inlineComments++
      }
    }

    let externalComments = 0
    for (const doc of external.sidecars.values()) {
      externalComments += doc.entries.length
    }

    const cacheEntries = yield* cache.size()
    return {
      mode: config.mode,
      commentsDir: config.commentsDir,
      configPath,
      configExists,
      sourceFiles: sources.size,
      sidecarFiles: external.sidecarFiles,
      inlineComments,
      externalComments,
      pragmasPreserved,
      cacheEntries,
      cachePath: config.cacheFile
    }
  })
