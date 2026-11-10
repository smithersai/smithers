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
import { normalizeEndColumns, unionEvidence, type FileCoverageJSON } from "../test/support/coverageUnion.ts"

const require = createRequire(import.meta.url)
const { createCoverageMap } = require("istanbul-lib-coverage")
const { createContext } = require("istanbul-lib-report")
const reports = require("istanbul-reports")
const { mergeScriptCovs } = createRequire(require.resolve("@vitest/coverage-v8"))("@bcoe/v8-coverage")
const root = fileURLToPath(new URL("../", import.meta.url))

/**
 * Full source roster plus actual V8 ranges. Exported for the real Chromium negative control.
 *
 * The compiler's structure of each source is the denominator. Vite's minified bundle has another shape for the same
 * source (two `if` returns folded into one ternary), and Istanbul's `merge` unions what it cannot match, so a merged
 * file counted both shapes. The bundle now credits the compiler structure by identical source range only, the fuzz
 * and bench gates' rule (test/support/coverageUnion.ts, decisions 0015 and 0016).
 */
export async function measure(entries: Iterable<any> | AsyncIterable<any>, directories = ["src", "worker", "scripts", "infra"]) {
  const included = (file: string) => file.endsWith(".vibe") && directories.some((directory) => file.startsWith(resolve(root, directory) + "/"))
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
        // The app's denominator is its four source directories; unrelated workspace/vendor chunks have no app counters.
        if (!map.sources.some((source: string) => included(fileURLToPath(source)))) continue
        const converted = await convert({
          code: entry.source,
          ast: await parseAstAsync(entry.source),
          sourceMap: map,
          coverage: { url: pathToFileURL(resolve(root, "dist/assets", new URL(entry.url).pathname.split("/").at(-1)!)).href, functions: mergeScriptCovs(scripts).functions },
          wrapperLength: 0,
        })
        evidence.push(converted as Record<string, FileCoverageJSON>)
    }
    const seed = createCoverageMap({})
    // Seed every full source, including loaded files: bundling may tree-shake an uncalled export from a loaded file.
    const compiler = projects({ root, project: resolve(root, "tsconfig.json"), compiler: findCompiler(root) })
    try {
      for (const directory of directories) {
        for (const entry of await readdir(resolve(root, directory), { recursive: true })) {
          if (!entry.endsWith(".vibe")) continue
          const file = resolve(root, directory, entry)
          const result = await compiler.load(file)
          if (result.error || result.errors.length > 0 || !result.map) throw new Error(`Cannot measure source: ${file}`)
          const map = structuredClone(result.map) as NonNullable<Parameters<typeof convert>[0]["sourceMap"]>
          map.sources = result.map.sources.map((source) => pathToFileURL(source).href)
          seed.merge(await convert({
            code: result.code, ast: await parseAstAsync(result.code), sourceMap: map,
            coverage: { url: pathToFileURL(file).href, functions: [] }, wrapperLength: 0,
          }))
        }
      }
    } finally {
      await compiler.close()
    }
    const coverage = createCoverageMap({})
    for (const file of seed.files() as string[]) {
      const text = await readFile(file, "utf8")
      let json = normalizeEndColumns(seed.fileCoverageFor(file).toJSON() as FileCoverageJSON, text)
      for (const bundle of evidence) {
        if (bundle[file] !== undefined) json = unionEvidence(json, normalizeEndColumns(bundle[file]!, text))
      }
      coverage.addFileCoverage(json)
    }
  return coverage
}

/** Remaps every executed bundle with the compiler/Vite maps; no test or generated JS is credited as source. */
export default class SourceCoverage implements Reporter {
  private readonly files = new Set<string>()
  private executed = 0
  private readonly counts = { passed: 0, expectedFailures: 0, skipped: 0, unexpected: 0 }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === "skipped") this.counts.skipped++
    else {
      this.executed++
      if (result.status === "failed" && test.expectedStatus === "failed") this.counts.expectedFailures++
      else if (result.status === "passed" && test.expectedStatus === "passed") this.counts.passed++
      else this.counts.unexpected++
    }
    for (const attachment of result.attachments) {
      if (attachment.name === "chromium-coverage" && attachment.path) this.files.add(attachment.path)
    }
  }

  async onEnd(result: FullResult) {
    console.info(`Chromium checks: ${this.counts.passed} passed; ${this.counts.expectedFailures} expected failures; ${this.counts.skipped} skipped; ${this.counts.unexpected} unexpected.`)
    if (this.executed === 0) return
    const files = this.files
    // One attachment at a time: each repeats the whole bundle and map, and together they exceed the heap.
    const coverage = await measure((async function* () {
      for (const file of files) yield* JSON.parse(await readFile(file, "utf8"))
    })())
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
    if (gaps.length > 0 || (this.files.size === 0 && result.status === "passed")) return { status: "failed" as const }
  }
}
