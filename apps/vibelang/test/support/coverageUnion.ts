// Stays .ts: Node 26 runs bench/merge-coverage.ts directly and imports this; fuzz/coverage.vibe imports it too.
//
// One cross-runtime merge for the benchmark gate (decision 0017) and the fuzz gate (decision 0015). Istanbul's own
// `merge` unions every statement and branch it has not seen at the same key, so a source compiled twice (Vitest's
// transform, Vite's minified bundle) gets both structures and is counted twice. Here the base runtime's structure is
// the gate and other runtimes credit it by source position after source maps:
//
// - A file with no base execution is gated on the first evidence structure that has it (all four metrics).
// - A file executed in the base keeps the base structure. Cross-runtime hits require identical complete source
//   ranges (and ordered arm ranges for branches). An enclosing statement or another same-line function cannot
//   establish execution. Different compiler shapes remain uncovered instead of being guessed.

export interface FileCoverageJSON {
  path: string
  statementMap: Record<string, { start: Position; end: Position }>
  fnMap: Record<string, { name: string; decl: { start: Position; end: Position }; loc?: { start: Position; end: Position } }>
  branchMap: Record<string, { loc: { start: Position; end: Position }; type: string; locations: Array<Arm> }>
  s: Record<string, number>
  f: Record<string, number>
  b: Record<string, Array<number>>
}
export interface Position { line: number; column: number | null }
/** A branch arm. Istanbul writes an `if` without `else` as an arm with no coordinates at all: `{ start: {}, end: {} }`. */
export interface Arm { start: Partial<Position>; end: Partial<Position> }

/** Same open-ended sentinel normalization as the coverage lane's patched V8 provider; no hit is changed. */
export function normalizeEndColumns(json: FileCoverageJSON, source: string): FileCoverageJSON {
  const copy = structuredClone(json)
  const lines = source.split(/\r?\n/)
  const normalize = (range: Arm | undefined) => {
    const position = range?.end
    if (position?.column === Infinity && position.line !== undefined && lines[position.line - 1] !== undefined) position.column = lines[position.line - 1]!.length
  }
  for (const loc of Object.values(copy.statementMap)) normalize(loc)
  for (const fn of Object.values(copy.fnMap)) { normalize(fn.decl); normalize(fn.loc) }
  for (const branch of Object.values(copy.branchMap)) { normalize(branch.loc); for (const loc of branch.locations) normalize(loc) }
  return copy
}

export function metrics(json: FileCoverageJSON) {
  const total = { lines: 0, statements: 0, functions: 0, branches: 0 }
  const covered = { lines: 0, statements: 0, functions: 0, branches: 0 }
  const lineHits = new Map<number, number>()
  // Istanbul defines executable lines by statement starts. A multi-line outer declaration does not execute
  // every nested body; spreading its hit over the entire range would credit unreachable statements.
  for (const [id, loc] of Object.entries(json.statementMap)) {
    const line = loc.start.line
    lineHits.set(line, Math.max(lineHits.get(line) ?? 0, json.s[id] ?? 0))
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

/** Credits a base-structured file with evidence for the same source from another runtime, by location. */
export function unionEvidence(base: FileCoverageJSON, evidence: FileCoverageJSON): FileCoverageJSON {
  const json = JSON.parse(JSON.stringify(base)) as FileCoverageJSON
  const location = (loc: Arm) => {
    const coordinates = [loc.start.line, loc.start.column, loc.end.line, loc.end.column]
    if (!coordinates.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return undefined
    return JSON.stringify(coordinates)
  }
  const statements = new Set(Object.entries(evidence.statementMap).filter(([id]) => (evidence.s[id] ?? 0) > 0).map(([, loc]) => location(loc)).filter(key => key !== undefined))
  const evidenceFns = new Set(Object.entries(evidence.fnMap).filter(([id]) => (evidence.f[id] ?? 0) > 0).map(([, fn]) => location(fn.decl)).filter(key => key !== undefined))
  const branchKey = (branch: FileCoverageJSON["branchMap"][string]) => {
    // The implicit else arm has no range in either runtime; it is identified by its branch's complete range.
    const implicit = (arm: Arm) => [arm.start.line, arm.start.column, arm.end.line, arm.end.column].every(value => value === undefined)
    const loc = location(branch.loc), arms = branch.locations.map(arm => implicit(arm) ? "implicit" : location(arm))
    return loc === undefined || arms.some(key => key === undefined) ? undefined : JSON.stringify([branch.type, loc, arms])
  }
  const evidenceBranches = new Map<string, Array<ReadonlyArray<number>>>()
  for (const [id, branch] of Object.entries(evidence.branchMap)) {
    const key = branchKey(branch)
    if (key === undefined) continue
    const list = evidenceBranches.get(key) ?? []
    list.push(evidence.b[id] ?? [])
    evidenceBranches.set(key, list)
  }
  for (const [id, loc] of Object.entries(json.statementMap)) {
    if ((json.s[id] ?? 0) > 0) continue
    const key = location(loc)
    if (key !== undefined && statements.has(key)) json.s[id] = 1
  }
  for (const [id, fn] of Object.entries(json.fnMap)) {
    if ((json.f[id] ?? 0) > 0) continue
    const key = location(fn.decl)
    if (key !== undefined && evidenceFns.has(key)) json.f[id] = 1
  }
  for (const [id, branch] of Object.entries(json.branchMap)) {
    const hits = json.b[id] ?? []
    if (hits.every((hit) => hit > 0)) continue
    const key = branchKey(branch)
    if (key === undefined) continue
    const candidates = evidenceBranches.get(key) ?? []
    // Every arm must have the same ordered source range, not just the same line and number of arms.
    json.b[id] = hits.map((hit, index) => hit > 0 || candidates.some(candidate => candidate.length === hits.length && (candidate[index] ?? 0) > 0) ? 1 : 0)
  }
  return json
}

/** The merged report, keyed by absolute source path: the base's structure, credited by each evidence in order. */
export function mergeByPosition(base: Readonly<Record<string, FileCoverageJSON>>, evidences: ReadonlyArray<Readonly<Record<string, FileCoverageJSON>>>): Record<string, FileCoverageJSON> {
  const combined: Record<string, FileCoverageJSON> = { ...base }
  for (const evidence of evidences) {
    for (const [file, json] of Object.entries(evidence)) {
      const existing = combined[file]
      // No base execution: the other runtime's structure is the gate for all four metrics.
      combined[file] = existing === undefined || metrics(existing).covered.statements === 0 ? json : unionEvidence(existing, json)
    }
  }
  return combined
}
