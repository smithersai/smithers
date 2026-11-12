// Stays .ts: Node 26 runs this gate directly (pnpm bench:coverage); Istanbul's untyped CJS API loads through
// createRequire behind local interfaces, and no VibeLang compilation step is wanted after the suite has run.
//
// The benchmark coverage gate (decision 0017). Vitest's V8 provider credits Node execution, including the emitted
// CLI/MCP/script subprocesses. Two other runtimes never enter Vitest's map, because their bundles are compiled again
// and would union a second statement structure into each shared source: workerd is a separate V8 isolate whose
// inspector disables the Profiler domain, so its bundles carry Istanbul counters dumped over the inspector
// (test/support/workerdCoverage.ts, per compiled module); Chromium executes the unminified source-coverage build, dumped with its precise Profiler
// API into coverage/bench/chromium-raw (bench/browser.spec.ts). This script remaps both to source, credits them by
// location (test/support/coverageUnion.ts, shared with the fuzz gate), and enforces 100% lines, branches, functions
// and statements per file:
//
// - A file with no Vitest-recorded execution is gated on its workerd-remapped structure (all four metrics).
// - A file executed in both keeps its Vitest structure. Cross-runtime hits require identical complete source
//   ranges (and ordered arm ranges for branches). An enclosing statement or another same-line function cannot
//   establish execution. Different compiler shapes remain uncovered instead of being guessed (0017).
// - Nothing is excluded: production code the product never runs is deleted, and code only proof contracts call
//   stays in the denominator, uncovered, until VibeLang has a specification-only function form (decision 0017).
import { createRequire } from "node:module"
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseAstAsync } from "vite"
import astV8ToIstanbul from "ast-v8-to-istanbul"
import { workerdEvidence } from "../test/support/workerdCoverage.ts"
import { sandboxEvidence, SANDBOX_COUNTER_DIRECTORY } from "./sandbox-evidence.ts"
import { mergeByPosition, metrics, normalizeEndColumns, type FileCoverageJSON } from "../test/support/coverageUnion.ts"

const require = createRequire(import.meta.url)

interface CoverageMap {
  files(): string[]
  fileCoverageFor(file: string): FileCoverage
  merge(other: CoverageMap | Record<string, unknown>): void
  toJSON(): Record<string, unknown>
}
interface FileCoverage {
  path: string
  toJSON(): FileCoverageJSON
}

const libCoverage = require("istanbul-lib-coverage") as {
  createCoverageMap(data?: Record<string, unknown>): CoverageMap
}

const appRoot = process.cwd().replaceAll("\\", "/")
const sourceFile = (file: string) =>
  file.startsWith(`${appRoot}/`) && /\.(vibe|js)$/.test(file) &&
  /\/(src|worker|infra|scripts|dist-factory|dist-scripts|dist-script-tests|dist\/assets)\//.test(file) &&
  !/\/dist\/assets\/rolldown-runtime-[^/]*\.js$/.test(file)

const workerdDir = "coverage/bench/workerd-raw"

interface ScriptCoverage {
  readonly url: string
  readonly functions: unknown
}

const chromiumDir = "coverage/bench/chromium-raw"

/**
 * Chromium's precise Profiler dumps of the source-coverage build, converted per script with the bundle's own map and
 * keyed by absolute source path. The bundle's statement structure is never merged into a source's Node structure;
 * only its hits are, by location, in the union below.
 */
async function chromiumEvidence(): Promise<CoverageMap> {
  const merged = libCoverage.createCoverageMap()
  if (!existsSync(chromiumDir)) return merged
  for (const name of readdirSync(chromiumDir).filter((name) => name.endsWith(".json"))) {
    const dump = JSON.parse(readFileSync(`${chromiumDir}/${name}`, "utf8")) as { result: ReadonlyArray<ScriptCoverage> }
    for (const script of dump.result) {
      const filename = fileURLToPath(script.url)
      // Generated bundler bootstrap ships no map and holds no production source (0017); skip it.
      if (!existsSync(`${filename}.map`)) continue
      const data = await astV8ToIstanbul({
        code: readFileSync(filename, "utf8"),
        sourceMap: JSON.parse(readFileSync(`${filename}.map`, "utf8")),
        ast: await parseAstAsync(readFileSync(filename, "utf8")),
        coverage: { functions: script.functions, url: script.url },
      } as never)
      const normalized: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(data)) {
        const path = isAbsolute(key) ? key : resolve(dirname(filename), key)
        const coverage = value as Record<string, unknown>
        normalized[path] = { ...coverage, path }
      }
      const filtered = libCoverage.createCoverageMap()
      for (const file of libCoverage.createCoverageMap(normalized).files()) {
        if (!file.endsWith(".vibe")) continue
        if (!file.startsWith(`${appRoot}/src/`) && !file.startsWith(`${appRoot}/worker/`) && !file.startsWith(`${appRoot}/infra/`) && !file.startsWith(`${appRoot}/scripts/`)) continue
        filtered.merge({ [file]: normalizeEndColumns(libCoverage.createCoverageMap(normalized).fileCoverageFor(file).toJSON(), readFileSync(file, "utf8")) })
      }
      merged.merge(filtered)
    }
  }
  return merged
}

function uncoveredLines(json: FileCoverageJSON): Array<number> {
  const lines = new Map<number, number>()
  for (const [id, loc] of Object.entries(json.statementMap)) {
    const line = loc.start.line
    lines.set(line, Math.max(lines.get(line) ?? 0, json.s[id] ?? 0))
  }
  return [...lines.entries()].filter(([, hits]) => hits === 0).map(([line]) => line).sort((x, y) => x - y)
}

async function main() {
  const vitestFinal = "coverage/bench/coverage-final.json"
  if (!existsSync(vitestFinal)) throw new Error("coverage/bench/coverage-final.json missing: run vitest coverage first")
  const base = libCoverage.createCoverageMap(JSON.parse(readFileSync(vitestFinal, "utf8")))
  const evidences: ReadonlyArray<Pick<CoverageMap, "files" | "toJSON">> = [await workerdEvidence(workerdDir, appRoot), await chromiumEvidence()]

  const vitest: Record<string, FileCoverageJSON> = {}
  for (const file of base.files()) {
    if (!sourceFile(file)) continue
    vitest[file] = base.fileCoverageFor(file).toJSON()
  }
  const deployed = await sandboxEvidence(SANDBOX_COUNTER_DIRECTORY, appRoot)
  const combined = mergeByPosition(vitest, [...evidences.map((evidence) => evidence.toJSON() as unknown as Record<string, FileCoverageJSON>), deployed])

  const failures: Array<string> = []
  const rows: Array<{ file: string; lines: string; statements: string; functions: string; branches: string; uncovered: string }> = []
  const finalMap: Record<string, FileCoverageJSON> = {}
  for (const [file, json] of Object.entries(combined).sort()) {
    const relative = file.slice(appRoot.length + 1)
    finalMap[file] = json
    const { total, covered } = metrics(json)
    const percent = (part: number, whole: number) => whole === 0 ? "100" : String(Math.round((part / whole) * 10000) / 100).replace(/\.0+$/, "")
    const bad: Array<string> = []
    if (covered.lines !== total.lines) bad.push("lines")
    if (covered.statements !== total.statements) bad.push("statements")
    if (covered.functions !== total.functions) bad.push("functions")
    if (covered.branches !== total.branches) bad.push("branches")
    const missing = uncoveredLines(json)
    rows.push({
      file: relative,
      lines: percent(covered.lines, total.lines),
      statements: percent(covered.statements, total.statements),
      functions: percent(covered.functions, total.functions),
      branches: percent(covered.branches, total.branches),
      uncovered: missing.length > 0 ? missing.slice(0, 12).join(",") + (missing.length > 12 ? ",…" : "") : "",
    })
    if (bad.length > 0) {
      failures.push(`${relative}: ${bad.map((name) => `${name} ${percent(covered[name as keyof typeof covered], total[name as keyof typeof total])}%`).join(", ")}${missing.length > 0 ? ` (uncovered lines: ${missing.join(",")})` : ""}`)
    }
  }

  // Runtime hits cannot substitute for the canonical Node source roster. An empty or foreign Node report must
  // fail even when a previous Worker/Chromium/deployed run left valid counters in the evidence directories.
  if (Object.keys(vitest).length === 0 || rows.length === 0) {
    console.error(`Benchmark coverage has no source files for this checkout's Node report (${appRoot}): rerun the suite here.`)
    process.exitCode = 1
    return
  }
  mkdirSync("coverage/bench/merged", { recursive: true })
  writeFileSync("coverage/bench/merged/coverage-final.json", JSON.stringify(finalMap, null, 1) + "\n")
  writeFileSync("coverage/bench/merged/per-file.json", JSON.stringify(rows, null, 1) + "\n")
  console.log(`Merged benchmark coverage: ${rows.length} files; Vitest (Node and emitted subprocesses) evidence plus ${evidences[0]!.files().length} workerd-evidenced, ${evidences[1]!.files().length} Chromium-evidenced and ${Object.keys(deployed).length} deployed sandbox-evidenced files.`)
  for (const row of rows.filter((row) => row.lines !== "100" || row.statements !== "100" || row.functions !== "100" || row.branches !== "100")) {
    console.log(`${row.file}: lines ${row.lines}% statements ${row.statements}% functions ${row.functions}% branches ${row.branches}%${row.uncovered === "" ? "" : ` uncovered ${row.uncovered}`}`)
  }
  if (failures.length > 0) {
    console.error(`Benchmark coverage gate failed for ${failures.length} files:`)
    for (const failure of failures) console.error(`ERROR: ${failure}`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
