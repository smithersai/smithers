// Stays .ts: Playwright loads reporters through its JS/TS loader.
import type { FullResult, Reporter, TestResult } from "@playwright/test/reporter"
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import convert from "ast-v8-to-istanbul"
import { parseAstAsync } from "vite"
import { findCompiler, projects } from "vibelang/project"

const require = createRequire(import.meta.url)
const { createCoverageMap } = require("istanbul-lib-coverage")
const { createContext } = require("istanbul-lib-report")
const reports = require("istanbul-reports")
const { mergeScriptCovs } = createRequire(require.resolve("@vitest/coverage-v8"))("@bcoe/v8-coverage")
const root = fileURLToPath(new URL("../", import.meta.url))

/** Same source-range normalization as the Vitest provider patch (186575ce); counters are untouched. */
async function finiteSourceRanges(coverage: Record<string, any>) {
  for (const [file, data] of Object.entries(coverage)) {
    const path = file.startsWith("file:") ? fileURLToPath(file) : file
    const source = await readFile(path, "utf8")
    const lines = source.split(/\r?\n/)
    const normalize = (range: any) => {
      const end = range?.end
      const line = end === undefined ? undefined : lines[end.line - 1]
      if (end?.column === Infinity && line !== undefined) end.column = line.length
    }
    for (const range of Object.values(data.statementMap)) normalize(range)
    for (const fn of Object.values(data.fnMap) as any[]) { normalize(fn.decl); normalize(fn.loc) }
    for (const branch of Object.values(data.branchMap) as any[]) {
      normalize(branch.loc)
      for (const range of branch.locations) normalize(range)
    }
  }
  return coverage
}

/** Remaps every executed bundle with the compiler/Vite maps; no test or generated JS is credited as source. */
export default class SourceCoverage implements Reporter {
  private readonly files = new Set<string>()
  private executed = 0

  onTestEnd(_test: unknown, result: TestResult) {
    if (result.status !== "skipped") this.executed++
    for (const attachment of result.attachments) {
      if (attachment.name === "chromium-coverage" && attachment.path) this.files.add(attachment.path)
    }
  }

  async onEnd(result: FullResult) {
    if (this.executed === 0) return
    const coverage = createCoverageMap({})
    // Merge Chromium ranges before parsing identical bundles; each test still retains its original evidence.
    const bundles = new Map<string, { entry: any; scripts: any[] }>()
    for (const file of this.files) {
      for (const entry of JSON.parse(await readFile(file, "utf8"))) {
        const key = `${entry.url}\n${entry.source}`
        const existing = bundles.get(key)
        const script = { scriptId: entry.scriptId, url: entry.url, functions: entry.functions }
        if (existing) existing.scripts.push(script)
        else bundles.set(key, { entry, scripts: [script] })
      }
    }
    for (const { entry, scripts } of bundles.values()) {
        const map = entry.sourceMap
        // Build sources are relative to dist/assets; keep all maps, filter only after remapping.
        map.sources = map.sources.map((source: string) => pathToFileURL(resolve(root, "dist/assets", source)).href)
        for (const [index, source] of map.sources.entries()) {
          const path = fileURLToPath(source)
          if (!path.startsWith(root) || !/\/(?:src|worker)\/.*\.vibe$/.test(path)) continue
          if (map.sourcesContent?.[index] !== await readFile(path, "utf8")) {
            throw new Error(`Source map does not describe this checkout: ${path}`)
          }
        }
        const converted = await convert({
          code: entry.source,
          ast: await parseAstAsync(entry.source),
          sourceMap: map,
          coverage: { url: pathToFileURL(resolve(root, "dist/assets", new URL(entry.url).pathname.split("/").at(-1)!)).href, functions: mergeScriptCovs(scripts).functions },
          wrapperLength: 0,
        })
        coverage.merge(await finiteSourceRanges(converted))
    }
    coverage.filter((file: string) => file.startsWith(root) && /\/(?:src|worker)\/.*\.vibe$/.test(file))
    // A source the browser never loads still belongs to the requested whole-app denominator.
    const compiler = projects({ root, project: resolve(root, "tsconfig.json"), compiler: findCompiler(root) })
    try {
      for (const directory of ["src", "worker"]) {
        for (const entry of await readdir(resolve(root, directory), { recursive: true })) {
          if (!entry.endsWith(".vibe")) continue
          const file = resolve(root, directory, entry)
          if (coverage.files().includes(file)) continue
          const result = await compiler.load(file)
          if (result.error || result.errors.length > 0 || !result.map) throw new Error(`Cannot measure source: ${file}`)
          const map = structuredClone(result.map) as NonNullable<Parameters<typeof convert>[0]["sourceMap"]>
          map.sources = result.map.sources.map((source) => pathToFileURL(source).href)
          coverage.merge(await finiteSourceRanges(await convert({
            code: result.code, ast: await parseAstAsync(result.code), sourceMap: map,
            coverage: { url: pathToFileURL(file).href, functions: [] }, wrapperLength: 0,
          })))
        }
      }
    } finally {
      await compiler.close()
    }
    const directory = resolve(root, "coverage/fuzz-browser")
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, "coverage-final.json"), JSON.stringify(coverage))
    const context = createContext({ dir: directory, coverageMap: coverage })
    for (const format of ["text", "json-summary", "html", "lcovonly"]) reports.create(format).execute(context)
    if (this.files.size === 0 && result.status === "passed") return { status: "failed" as const }
  }
}
