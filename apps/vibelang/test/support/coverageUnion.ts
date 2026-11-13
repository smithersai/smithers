// Stays .ts: Node 26 runs bench/merge-coverage.ts directly and imports this; fuzz/coverage.vibe imports it too.
//
// One cross-runtime merge for the benchmark gate (decision 0017) and the fuzz gate (decision 0015). Istanbul's own
// `merge` unions every statement and branch it has not seen at the same key, so a source compiled twice (Vitest's
// transform, Vite's minified bundle) gets both structures and is counted twice. Here the base runtime's structure is
// the gate and other runtimes credit it by source position after source maps:
//
// - A file with no base execution is gated on the first evidence structure that has it (all four metrics).
// - A file executed in the base keeps the base structure. Cross-runtime hits require the identical source start: a
//   statement's, a function body's (Istanbul's own function key; an arrow's declaration
//   maps to its parameters in one map and its name in the other), and for branches the same type with the same ordered arm starts. Ends are
//   not compared: a map composed through Vite infers each end from the next mapped token, so the same `if` arm ends
//   at column 36 in the compiler's map and 38 in the bundle's (decision 0016). An enclosing statement or another
//   same-line function starts elsewhere and cannot establish execution. Different compiler shapes remain uncovered
//   instead of being guessed.

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
    const coordinates = [loc.start.line, loc.start.column]
    if (!coordinates.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return undefined
    return JSON.stringify(coordinates)
  }
  const statements = new Set(Object.entries(evidence.statementMap).filter(([id]) => (evidence.s[id] ?? 0) > 0).map(([, loc]) => location(loc)).filter(key => key !== undefined))
  const evidenceFns = new Set(Object.entries(evidence.fnMap).filter(([id]) => (evidence.f[id] ?? 0) > 0).map(([, fn]) => location(fn.loc ?? fn.decl)).filter(key => key !== undefined))
  const branchKey = (branch: FileCoverageJSON["branchMap"][string]) => {
    // A branch is its type and its ordered arm starts, Istanbul's own key. Its own range is not compared: a logical
    // expression's start maps to its first operand in one map and an enclosing parenthesis in the other. The implicit
    // else arm has no range in either runtime; it follows the `if` arm that precedes it.
    const implicit = (arm: Arm) => [arm.start.line, arm.start.column, arm.end.line, arm.end.column].every(value => value === undefined)
    const arms = branch.locations.map(arm => implicit(arm) ? "implicit" : location(arm))
    return arms.some(key => key === undefined) || arms.every(key => key === "implicit") ? undefined : JSON.stringify([branch.type, arms])
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
    const key = location(fn.loc ?? fn.decl)
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

/**
 * The structure a bundle runs, for a source the bundle contains: the bundle's statements, functions and branches, plus
 * each compiler item whose start no bundle statement or function contains (tree-shaken code). Rolldown prints no
 * source-map segment at some starts, an arrow or parenthesized initializer among them, so the bundle starts
 * `const next = (a ?? 0)` at `next` where the compiler starts it at `(`, sometimes a line earlier; matched by start
 * against the compiler's structure, Chromium's run of it would never count (decision 0016,
 * ~/vl/vibelang-bugs/coverage-source-ranges/rolldown-segments). The two structures then differ only where the bundler
 * changed the code. Items that share a source start count once: the gate credits by start, and Rolldown can map two
 * functions to one (an inner `make` renamed `make_2`).
 */
export function builtStructure(compiler: FileCoverageJSON, bundle: FileCoverageJSON): FileCoverageJSON {
  const json: FileCoverageJSON = { ...structuredClone(compiler), statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} }
  const order = (position: Partial<Position>) => [position.line ?? -1, position.column ?? -1] as const
  const before = (a: Partial<Position>, b: Partial<Position>) => order(a)[0] < order(b)[0] || (order(a)[0] === order(b)[0] && order(a)[1] <= order(b)[1])
  const ranges = [...Object.values(bundle.statementMap), ...Object.values(bundle.fnMap).map(fn => fn.loc ?? fn.decl)]
  const contained = (position: Partial<Position>) => ranges.some(range => before(range.start, position) && before(position, range.end))
  const start = (range: { start: Partial<Position> }) => `${range.start.line}:${range.start.column}`
  const seen = { s: new Set<string>(), f: new Set<string>(), b: new Set<string>() }
  const first = (kind: keyof typeof seen, key: string) => !seen[kind].has(key) && Boolean(seen[kind].add(key))
  for (const [owner, kept] of [[bundle, () => true], [compiler, (position: Partial<Position>) => !contained(position)]] as const) {
    for (const [id, loc] of Object.entries(owner.statementMap)) {
      if (!kept(loc.start) || !first("s", start(loc))) continue
      const key = String(Object.keys(json.statementMap).length)
      json.statementMap[key] = structuredClone(loc)
      json.s[key] = owner.s[id] ?? 0
    }
    for (const [id, fn] of Object.entries(owner.fnMap)) {
      if (!kept((fn.loc ?? fn.decl).start) || !first("f", start(fn.loc ?? fn.decl))) continue
      const key = String(Object.keys(json.fnMap).length)
      json.fnMap[key] = structuredClone(fn)
      json.f[key] = owner.f[id] ?? 0
    }
    for (const [id, branch] of Object.entries(owner.branchMap)) {
      if (!kept(branch.loc.start) || !first("b", JSON.stringify([branch.type, start(branch.loc), branch.locations.map(start)]))) continue
      const key = String(Object.keys(json.branchMap).length)
      json.branchMap[key] = structuredClone(branch)
      json.b[key] = [...(owner.b[id] ?? branch.locations.map(() => 0))]
    }
  }
  return json
}

/**
 * The merged report, keyed by absolute source path, credited by each evidence in order.
 * A whole-source gate keeps even an unexecuted base structure: partial evidence cannot shrink its denominator.
 */
export function mergeByPosition(base: Readonly<Record<string, FileCoverageJSON>>, evidences: ReadonlyArray<Readonly<Record<string, FileCoverageJSON>>>, keepBaseStructure = false): Record<string, FileCoverageJSON> {
  const combined: Record<string, FileCoverageJSON> = { ...base }
  for (const evidence of evidences) {
    for (const [file, json] of Object.entries(evidence)) {
      const existing = combined[file]
      // Outside a whole-source gate, no base execution makes the other runtime's structure the gate.
      combined[file] = existing === undefined || (!keepBaseStructure && metrics(existing).covered.statements === 0) ? json : unionEvidence(existing, json)
    }
  }
  return combined
}
