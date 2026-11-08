// Stays .ts: Node 26 runs this gate directly (pnpm bench:coverage); Istanbul's untyped CJS API loads through
// createRequire behind local interfaces, and no VibeLang compilation step is wanted after the suite has run.
//
// The benchmark coverage gate (decision 0017). Vitest's V8 provider credits Node execution, including the emitted
// CLI/MCP/script subprocesses. Two other runtimes never enter Vitest's map, because their bundles are compiled again
// and would union a second statement structure into each shared source: workerd is a separate V8 isolate whose
// inspector disables the Profiler domain, so its bundles carry Istanbul counters dumped over the inspector
// (test/support/workerdCoverage.ts); Chromium executes the minified site bundle, dumped with its precise Profiler
// API into coverage/bench/chromium-raw (bench/browser.spec.ts). This script remaps both to source, credits them by
// location, and enforces 100% lines, branches, functions and statements per file:
//
// - A file with no Vitest-recorded execution is gated on its workerd-remapped structure (all four metrics).
// - A file executed in both keeps its Vitest structure, with each uncovered statement, function or branch credited
//   when the workerd evidence covers the same source location. The two compilers emit different shapes for one
//   source, so this union is by start line (and arm count for branches): exact for this codebase's one-statement-
//   per-line style, heuristic for same-line constructs (limitation, 0017).
// - Lines no benchmark should run are excluded only with their reason recorded here and in decision 0017.
import { createRequire } from "node:module"
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseAstAsync } from "vite"
import astV8ToIstanbul from "ast-v8-to-istanbul"

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
interface FileCoverageJSON {
  path: string
  statementMap: Record<string, { start: Position; end: Position }>
  fnMap: Record<string, { name: string; decl: { start: Position; end: Position } }>
  branchMap: Record<string, { loc: { start: Position; end: Position }; type: string; locations: Array<{ start: Position; end: Position }> }>
  s: Record<string, number>
  f: Record<string, number>
  b: Record<string, Array<number>>
}
interface Position { line: number; column: number | null }
interface SourceMapStore { registerMap(filename: string, map: unknown): void; transformCoverage(map: CoverageMap): Promise<CoverageMap> }

const libCoverage = require("istanbul-lib-coverage") as {
  createCoverageMap(data?: Record<string, unknown>): CoverageMap
}
const libSourceMaps = require("istanbul-lib-source-maps") as {
  createSourceMapStore(): SourceMapStore
}

const appRoot = process.cwd().replaceAll("\\", "/")
const sourceFile = (file: string) =>
  file.startsWith(`${appRoot}/`) && /\.(vibe|js)$/.test(file) &&
  /\/(src|worker|infra|scripts|dist-factory|dist-scripts|dist-script-tests|dist\/assets)\//.test(file) &&
  !/\/dist\/assets\/rolldown-runtime-[^/]*\.js$/.test(file)

// Exclusions: lines no benchmark should run, each with its reason, mirrored in decision 0017.
const exclusions: ReadonlyArray<{ file: string; lines: ReadonlyArray<number>; reason: string }> = [
  {
    file: "scripts/mythical-seed.vibe",
    lines: [103],
    reason: "The Refused guard fires only if seedOf violates its contract: intentsOf guarantees decide accepts every seeded intent, and decideWithinCapacity refuses only at 2^53 events. Unreachable from real input.",
  },
]

const workerdDir = "coverage/bench/workerd-raw"

async function workerdEvidence(): Promise<CoverageMap> {
  const merged = libCoverage.createCoverageMap()
  if (!existsSync(workerdDir)) return merged
  for (const name of readdirSync(workerdDir).filter((name) => name.endsWith(".json"))) {
    // The counters' locations are already in bundle coordinates, so the bundler's map is the only remap.
    const dump = JSON.parse(readFileSync(`${workerdDir}/${name}`, "utf8")) as { coverage: Record<string, unknown>; bundleMap: unknown }
    const store = libSourceMaps.createSourceMapStore()
    store.registerMap("/bundle/worker.js", dump.bundleMap)
    const sourceLevel = await store.transformCoverage(libCoverage.createCoverageMap(dump.coverage))
    const filtered = libCoverage.createCoverageMap()
    for (const file of sourceLevel.files()) {
      if (!file.endsWith(".vibe")) continue
      if (!file.startsWith(`${appRoot}/src/`) && !file.startsWith(`${appRoot}/worker/`) && !file.startsWith(`${appRoot}/infra/`) && !file.startsWith(`${appRoot}/scripts/`)) continue
      filtered.merge({ [file]: sourceLevel.fileCoverageFor(file).toJSON() })
    }
    merged.merge(filtered)
  }
  return merged
}

interface ScriptCoverage {
  readonly url: string
  readonly functions: unknown
}

const chromiumDir = "coverage/bench/chromium-raw"

/**
 * Chromium's precise Profiler dumps of the minified site bundle, converted per script with the bundle's own map and
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
        filtered.merge({ [file]: libCoverage.createCoverageMap(normalized).fileCoverageFor(file).toJSON() })
      }
      merged.merge(filtered)
    }
  }
  return merged
}

function compact(json: FileCoverageJSON): FileCoverageJSON {
  const statementIds = Object.keys(json.statementMap).sort((x, y) => Number(x) - Number(y))
  const fnIds = Object.keys(json.fnMap).sort((x, y) => Number(x) - Number(y))
  const branchIds = Object.keys(json.branchMap).sort((x, y) => Number(x) - Number(y))
  const out: FileCoverageJSON = { ...json, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} }
  statementIds.forEach((id, index) => { out.statementMap[index] = json.statementMap[id]!; out.s[index] = json.s[id] ?? 0 })
  fnIds.forEach((id, index) => { out.fnMap[index] = json.fnMap[id]!; out.f[index] = json.f[id] ?? 0 })
  branchIds.forEach((id, index) => { out.branchMap[index] = json.branchMap[id]!; out.b[index] = json.b[id] ?? [] })
  return out
}

function excludeLines(json: FileCoverageJSON, lines: ReadonlyArray<number>): FileCoverageJSON {
  const excluded = new Set(lines)
  const kept: FileCoverageJSON = JSON.parse(JSON.stringify(json))
  for (const id of Object.keys(kept.statementMap)) if (excluded.has(kept.statementMap[id]!.start.line)) { delete kept.statementMap[id]; delete kept.s[id] }
  for (const id of Object.keys(kept.fnMap)) if (excluded.has(kept.fnMap[id]!.decl.start.line)) { delete kept.fnMap[id]; delete kept.f[id] }
  for (const id of Object.keys(kept.branchMap)) if (excluded.has(kept.branchMap[id]!.loc.start.line)) { delete kept.branchMap[id]; delete kept.b[id] }
  return compact(kept)
}

function lineSpans(json: FileCoverageJSON): ReadonlyArray<readonly [number, number, number]> {
  return Object.entries(json.statementMap).map(([id, loc]) => [loc.start.line, loc.end.line ?? loc.start.line, json.s[id] ?? 0])
}

function uncoveredLines(json: FileCoverageJSON): Array<number> {
  const lines = new Map<number, number>()
  for (const [start, end, hits] of lineSpans(json)) {
    for (let line = start; line <= end; line++) lines.set(line, Math.max(lines.get(line) ?? 0, hits))
  }
  return [...lines.entries()].filter(([, hits]) => hits === 0).map(([line]) => line).sort((x, y) => x - y)
}

function metrics(json: FileCoverageJSON) {
  const total = { lines: 0, statements: 0, functions: 0, branches: 0 }
  const covered = { lines: 0, statements: 0, functions: 0, branches: 0 }
  const lineHits = new Map<number, number>()
  for (const [start, end, hits] of lineSpans(json)) {
    for (let line = start; line <= end; line++) lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits))
  }
  total.lines = lineHits.size
  covered.lines = [...lineHits.values()].filter((hits) => hits > 0).length
  total.statements = Object.keys(json.s).length
  covered.statements = Object.values(json.s).filter((hits) => hits > 0).length
  total.functions = Object.keys(json.f).length
  covered.functions = Object.values(json.f).filter((hits) => hits > 0).length
  for (const hits of Object.values(json.b)) {
    total.branches += hits.length
    covered.branches += hits.filter((hit) => hit > 0).length
  }
  return { total, covered }
}

/** Credits a Vitest-structured file with evidence for the same source from another runtime, by location. */
function unionEvidence(base: FileCoverageJSON, evidence: FileCoverageJSON): FileCoverageJSON {
  const json = JSON.parse(JSON.stringify(base)) as FileCoverageJSON
  const spans = lineSpans(evidence)
  const hitAt = (line: number) => spans.some(([start, end, hits]) => start <= line && line <= end && hits > 0)
  const evidenceFns = new Map<number, number>()
  for (const [id, fn] of Object.entries(evidence.fnMap)) evidenceFns.set(fn.decl.start.line, Math.max(evidenceFns.get(fn.decl.start.line) ?? 0, evidence.f[id] ?? 0))
  const evidenceBranches = new Map<number, Array<ReadonlyArray<number>>>()
  for (const [id, branch] of Object.entries(evidence.branchMap)) {
    const list = evidenceBranches.get(branch.loc.start.line) ?? []
    list.push(evidence.b[id] ?? [])
    evidenceBranches.set(branch.loc.start.line, list)
  }
  for (const [id, loc] of Object.entries(json.statementMap)) {
    if ((json.s[id] ?? 0) > 0) continue
    let hit = 0
    for (let line = loc.start.line; line <= (loc.end.line ?? loc.start.line); line++) if (hitAt(line)) hit = 1
    if (hit > 0) json.s[id] = hit
  }
  for (const [id, fn] of Object.entries(json.fnMap)) {
    if ((json.f[id] ?? 0) > 0) continue
    if ((evidenceFns.get(fn.decl.start.line) ?? 0) > 0) json.f[id] = 1
  }
  for (const [id, branch] of Object.entries(json.branchMap)) {
    const hits = json.b[id] ?? []
    if (hits.every((hit) => hit > 0)) continue
    const candidates = evidenceBranches.get(branch.loc.start.line) ?? []
    // Arms across two compilers are matched only when the node has the same shape and every arm ran.
    if (candidates.some((candidate) => candidate.length === hits.length && candidate.every((hit) => hit > 0))) {
      json.b[id] = hits.map(() => 1)
    }
  }
  return json
}

async function main() {
  const vitestFinal = "coverage/bench/coverage-final.json"
  if (!existsSync(vitestFinal)) throw new Error("coverage/bench/coverage-final.json missing: run vitest coverage first")
  const base = libCoverage.createCoverageMap(JSON.parse(readFileSync(vitestFinal, "utf8")))
  const evidences: ReadonlyArray<CoverageMap> = [await workerdEvidence(), await chromiumEvidence()]

  const combined: Record<string, FileCoverageJSON> = {}
  for (const file of base.files()) {
    if (!sourceFile(file)) continue
    combined[file] = base.fileCoverageFor(file).toJSON()
  }
  for (const evidenceMap of evidences) {
    for (const file of evidenceMap.files()) {
      const evidence = evidenceMap.fileCoverageFor(file).toJSON()
      const existing = combined[file]
      if (existing === undefined || metrics(existing).covered.statements === 0) {
        // No Node-side execution: the other runtime's structure is the gate for all four metrics.
        combined[file] = evidence
        continue
      }
      combined[file] = unionEvidence(existing, evidence)
    }
  }

  const failures: Array<string> = []
  const rows: Array<{ file: string; lines: string; statements: string; functions: string; branches: string; uncovered: string }> = []
  const finalMap: Record<string, FileCoverageJSON> = {}
  for (const [file, original] of Object.entries(combined).sort()) {
    const relative = file.slice(appRoot.length + 1)
    const exclusion = exclusions.find((candidate) => candidate.file === relative)
    const json = exclusion === undefined ? original : excludeLines(original, exclusion.lines)
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

  mkdirSync("coverage/bench/merged", { recursive: true })
  writeFileSync("coverage/bench/merged/coverage-final.json", JSON.stringify(finalMap, null, 1) + "\n")
  writeFileSync("coverage/bench/merged/per-file.json", JSON.stringify(rows, null, 1) + "\n")
  console.log(`Merged benchmark coverage: ${rows.length} files; Vitest (Node and emitted subprocesses) evidence plus ${evidences[0]!.files().length} workerd-evidenced and ${evidences[1]!.files().length} Chromium-evidenced files.`)
  for (const row of rows.filter((row) => row.lines !== "100" || row.statements !== "100" || row.functions !== "100" || row.branches !== "100")) {
    console.log(`${row.file}: lines ${row.lines}% statements ${row.statements}% functions ${row.functions}% branches ${row.branches}%${row.uncovered === "" ? "" : ` uncovered ${row.uncovered}`}`)
  }
  if (failures.length > 0) {
    console.error(`Benchmark coverage gate failed for ${failures.length} files:`)
    for (const failure of failures) console.error(`ERROR: ${failure}`)
    process.exitCode = 1
  }
}

await main()
