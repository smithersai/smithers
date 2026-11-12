// Stays .ts: Playwright loads reporters through its JS/TS loader.
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter"
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import convert from "ast-v8-to-istanbul"
import { parseAstAsync } from "vite"
import { findCompiler, projects } from "vibelang/project"
import { builtStructure, normalizeEndColumns, unionEvidence, type FileCoverageJSON } from "../test/support/coverageUnion.ts"
import { readEntries } from "./coverageStore.ts"

const require = createRequire(import.meta.url)
const { createCoverageMap } = require("istanbul-lib-coverage")
const { createContext } = require("istanbul-lib-report")
const reports = require("istanbul-reports")
const { mergeScriptCovs } = createRequire(require.resolve("@vitest/coverage-v8"))("@bcoe/v8-coverage")
const root = fileURLToPath(new URL("../", import.meta.url))

/**
 * The roster's full sources plus actual V8 ranges. Exported for the real Chromium negative control.
 *
 * Each source's structure is the denominator: the structure of `build`, the bundle Chromium runs, for the code the
 * bundle contains, and the compiler's for the rest (tree-shaken exports, unloaded files). The compiler's starts alone
 * are not enough: Rolldown prints no source-map segment at some of them (decision 0016), so Chromium's run of those
 * statements could never count. Vite's minified bundle has another shape again (two `if` returns folded into one
 * ternary), and Istanbul's `merge` unions what it cannot match, so a merged file counted both shapes. Executed bundles
 * credit the structure by identical source start only, the fuzz and bench gates' rule (test/support/coverageUnion.ts,
 * decisions 0015 and 0016). Without `build` (a deployment's run), the compiler's structure is the denominator.
 * `project` is the tsconfig that compiles the roster and must include every rostered source; the gate uses the app's.
 */
export async function measure(entries: Iterable<any> | AsyncIterable<any>, sources: ReadonlyArray<string>, build: Iterable<BuiltScript> = [], project = resolve(root, "tsconfig.json")) {
  const roster = new Set(sources)
  const included = (file: string) => roster.has(file)
  /** A bundle's Istanbul structure per included source, after its source map; undefined when it has none. */
  const remap = async (entry: BuiltScript, functions: unknown[]) => {
    const map = structuredClone(entry.sourceMap)
    // Build sources are relative to dist/assets; keep all maps, filter only after remapping.
    map.sources = map.sources.map((source: string) => pathToFileURL(resolve(root, "dist/assets", source)).href)
    for (const [index, source] of map.sources.entries()) {
      const path = fileURLToPath(source)
      if (!included(path)) continue
      if (map.sourcesContent?.[index] !== await readFile(path, "utf8")) {
        throw new Error(`Source map does not describe this checkout: ${path}`)
      }
    }
    // Chunks with no measured source (vendor, workspace packages, fault pages) have no app counters.
    if (!map.sources.some((source: string) => included(fileURLToPath(source)))) return undefined
    return await convert({
      code: entry.source,
      ast: await parseAstAsync(entry.source),
      sourceMap: map,
      coverage: { url: pathToFileURL(resolve(root, "dist/assets", new URL(entry.url).pathname.split("/").at(-1)!)).href, functions: functions as any },
      wrapperLength: 0,
    }) as Record<string, FileCoverageJSON>
  }
    const evidence: Array<Record<string, FileCoverageJSON>> = []
    // Merge Chromium ranges before parsing identical bundles; each test still retains its original evidence.
    const bundles = new Map<string, { entry: any; scripts: any[] }>()
    for await (const entry of entries) {
        const key = `${entry.url}\n${createHash("sha256").update(entry.source).digest("hex")}`
        const existing = bundles.get(key)
        const script = { scriptId: entry.scriptId, url: entry.url, functions: structuredClone(entry.functions) }
        if (!existing) bundles.set(key, { entry, scripts: [script] })
        else {
          existing.scripts.push(script)
          // Hit counts add under merging, so compacting here bounds memory without changing the result.
          if (existing.scripts.length >= 16) existing.scripts = [mergeScriptCovs(existing.scripts)]
        }
    }
    for (const { entry, scripts } of bundles.values()) {
        const converted = await remap(entry, mergeScriptCovs(scripts).functions)
        if (converted) evidence.push(converted)
    }
    // The build's structure with no hits: each chunk once, executed or not.
    const built = createCoverageMap({})
    const chunks = new Set<string>()
    for (const chunk of build) {
      const hash = createHash("sha256").update(chunk.source).digest("hex")
      if (chunks.has(hash)) continue
      chunks.add(hash)
      const converted = await remap(chunk, [])
      if (converted) built.merge(converted)
    }
    const seed = createCoverageMap({})
    // Seed every full source, including loaded files: bundling may tree-shake an uncalled export from a loaded file.
    const compiler = projects({ root, project, compiler: findCompiler(root) })
    try {
      for (const file of roster) {
        const result = await compiler.load(file)
        if (result.error || result.errors.length > 0 || !result.map) throw new Error(`Cannot measure source: ${file}`)
        const map = structuredClone(result.map) as NonNullable<Parameters<typeof convert>[0]["sourceMap"]>
        map.sources = result.map.sources.map((source) => pathToFileURL(source).href)
        seed.merge(await convert({
          code: result.code, ast: await parseAstAsync(result.code), sourceMap: map,
          coverage: { url: pathToFileURL(file).href, functions: [] }, wrapperLength: 0,
        }))
      }
    } finally {
      await compiler.close()
    }
    const coverage = createCoverageMap({})
    for (const file of seed.files() as string[]) {
      const text = await readFile(file, "utf8")
      let json = normalizeEndColumns(seed.fileCoverageFor(file).toJSON() as FileCoverageJSON, text)
      if (built.data[file] !== undefined) json = builtStructure(json, normalizeEndColumns(built.fileCoverageFor(file).toJSON() as FileCoverageJSON, text))
      for (const bundle of evidence) {
        if (bundle[file] !== undefined) json = unionEvidence(json, normalizeEndColumns(bundle[file]!, text))
      }
      coverage.addFileCoverage(json)
    }
  return coverage
}

/** Every `.vibe` file under the given app directories: the fixture controls' roster. */
export async function sourcesIn(directories: ReadonlyArray<string>, app = root): Promise<Array<string>> {
  const files: Array<string> = []
  for (const directory of directories) {
    for (const entry of await readdir(resolve(app, directory), { recursive: true })) {
      if (entry.endsWith(".vibe")) files.push(resolve(app, directory, entry))
    }
  }
  return files.sort()
}

/** The app's source directories; an app source the bundle ships lies in one of them. */
const appDirectories = ["src", "worker", "scripts", "infra"]

/**
 * The browser gate's roster (decision 0016, "Browser gate scope"): every `.vibe` file in `src/web`, plus every app
 * source the build's source maps name. A bundled source counts whole, including exports tree-shaking dropped.
 * `src/surfaces`, `scripts`, `worker` and `infra` code that no chunk ships runs in no browser; the unit and workerd gates
 * measure it, so the browser gate's 100% is reachable without dropping anything from them.
 */
export async function browserSources(app = root): Promise<Array<string>> {
  const files = new Set(await sourcesIn(["src/web"], app))
  const assets = resolve(app, "dist/assets")
  const names = (await readdir(assets).catch(() => [])).filter((name) => name.endsWith(".js.map"))
  if (names.length === 0) throw new Error(`The browser gate found no source maps in ${assets}: build the site first`)
  for (const name of names) {
    const map = JSON.parse(await readFile(resolve(assets, name), "utf8")) as { sources: ReadonlyArray<string> }
    for (const source of map.sources) {
      const file = resolve(assets, source)
      if (file.endsWith(".vibe") && appDirectories.some((directory) => file.startsWith(resolve(app, directory) + "/"))) files.add(file)
    }
  }
  return [...files].sort()
}

/**
 * Whether the strict gate fails: a metric below 100%, an executed check that attached no Chromium evidence, or a green
 * run with no evidence at all. A check without evidence ran code the report cannot see, so its gaps would be false.
 */
export function gateFailed(gaps: number, unmeasured: number, evidence: number, status: FullResult["status"]): boolean {
  return gaps > 0 || unmeasured > 0 || (evidence === 0 && status === "passed")
}

/** One emitted chunk and its source map, as Vite wrote them. */
export interface BuiltScript { readonly url: string; readonly source: string; readonly sourceMap: any }

/** Every chunk of a local build that has a source map: the structure Chromium runs, executed or not. */
export async function readBuild(directory = resolve(root, "dist/assets")): Promise<BuiltScript[]> {
  const chunks: BuiltScript[] = []
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".js")) continue
    const path = resolve(directory, name)
    const mapText = await readFile(`${path}.map`, "utf8").catch(() => undefined)
    if (mapText === undefined) continue
    chunks.push({ url: pathToFileURL(path).href, source: await readFile(path, "utf8"), sourceMap: JSON.parse(mapText) })
  }
  return chunks
}

/** Remaps every executed bundle with the compiler/Vite maps; no test or generated JS is credited as source. */
export default class SourceCoverage implements Reporter {
  private readonly files = new Set<string>()
  private executed = 0
  private readonly counts = { passed: 0, expectedFailures: 0, skipped: 0, unexpected: 0 }
  private readonly unmeasured: Array<string> = []

  /** Executed checks with no Chromium evidence: their spec imports `test` from "@playwright/test", not "./coverage". */
  get missingEvidence(): ReadonlyArray<string> {
    return this.unmeasured
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === "skipped") this.counts.skipped++
    else {
      this.executed++
      if (result.status === "failed" && test.expectedStatus === "failed") this.counts.expectedFailures++
      else if (result.status === "passed" && test.expectedStatus === "passed") this.counts.passed++
      else this.counts.unexpected++
      if (!result.attachments.some((attachment) => attachment.name === "chromium-coverage" && attachment.path)) {
        this.unmeasured.push(`${test.location.file.startsWith(root) ? test.location.file.slice(root.length) : test.location.file}:${test.location.line} ${test.title}`)
      }
    }
    for (const attachment of result.attachments) {
      if (attachment.name === "chromium-coverage" && attachment.path) this.files.add(attachment.path)
    }
  }

  async onEnd(result: FullResult) {
    console.info(`Chromium checks: ${this.counts.passed} passed; ${this.counts.expectedFailures} expected failures; ${this.counts.skipped} skipped; ${this.counts.unexpected} unexpected.`)
    if (this.unmeasured.length > 0) console.error(`Chromium checks without coverage evidence (import test from "./coverage"): ${this.unmeasured.length}\n${this.unmeasured.join("\n")}`)
    if (this.executed === 0) return
    const files = this.files
    // One attachment at a time; each script's source and map are read once (coverageStore.ts).
    // A deployment runs its own build; only a local run measures against the chunks it served (decision 0016).
    const build = process.env.E2E_BASE_URL === undefined ? await readBuild() : []
    console.info(`Chromium structure: ${build.length} build chunks.`)
    const sources = await browserSources()
    console.info(`Chromium roster: ${sources.length} sources (src/web and what the bundle ships; decision 0016).`)
    const coverage = await measure(readEntries(files), sources, build)
    const directory = resolve(root, "coverage/browser")
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, "coverage-final.json"), JSON.stringify(coverage))
    const context = createContext({ dir: directory, coverageMap: coverage })
    for (const format of ["text", "json-summary", "html", "lcovonly"]) reports.create(format).execute(context)
    const metrics = ["lines", "branches", "functions", "statements"] as const
    const gaps = coverage.files().flatMap((file: string) => {
      const summary = coverage.fileCoverageFor(file).toSummary().toJSON()
      return metrics.filter((metric) => summary[metric].pct < 100).map((metric) => `${file.slice(root.length)}: ${metric} ${summary[metric].pct}% < 100%`)
    })
    // `pnpm e2e` always measures and reports; only `pnpm e2e:coverage` (decision 0016) fails below 100%.
    const strict = process.env.E2E_COVERAGE_GATE === "1"
    console.info(`Chromium coverage: ${coverage.files().length} files, ${gaps.length} metrics below 100%; report in coverage/browser.`)
    if (!strict) return
    if (gaps.length > 0) console.error(`Chromium coverage gate failed:\n${gaps.join("\n")}`)
    if (gateFailed(gaps.length, this.unmeasured.length, this.files.size, result.status)) return { status: "failed" as const }
  }
}
