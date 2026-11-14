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
/** A source position a bundle's map names: 1-based line, 0-based column, as Istanbul counts them. */
export type SourcePosition = readonly [line: number, column: number]

const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
/** Every original position a source map's `mappings` name, per source index: where the bundle emits each source. */
export function emittedPositions(mappings: string): Map<number, Array<SourcePosition>> {
  const positions = new Map<number, Array<SourcePosition>>()
  let source = 0
  let line = 0
  let column = 0
  for (const row of mappings.split(";")) {
    for (const segment of row.split(",")) {
      const fields: Array<number> = []
      let value = 0
      let shift = 0
      for (const char of segment) {
        const digit = base64.indexOf(char)
        if (digit < 0) throw new Error(`Source map mappings hold a character that is not base64: ${char}`)
        value += (digit & 31) * 2 ** shift
        if ((digit & 32) !== 0) shift += 5
        else {
          fields.push(value % 2 === 1 ? -Math.floor(value / 2) : value / 2)
          value = 0
          shift = 0
        }
      }
      if (fields.length < 4) continue
      source += fields[1]!
      line += fields[2]!
      column += fields[3]!
      const list = positions.get(source) ?? []
      list.push([line + 1, column])
      positions.set(source, list)
    }
  }
  return positions
}
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
 * The bundle's structure plus unmatched compiler obligations, including code removed inside retained functions.
 * A replacement has the same kind and source start; a branch also has the same number of arms. For a statement whose initializer start Rolldown leaves
 * unmapped, pair just one compiler statement with the same end and the closest start. A containing function or
 * declaration cannot replace its nested statements, functions or branches (decision 0016).
 * `emitted` is every source position the bundle's maps name (`emittedPositions`). Rolldown inlines a `const` read once
 * into the statement that reads it, so the bundle has no statement at its start, yet its code ships inside the reading
 * statement, which Chromium credits: a compiler statement with code shipped in it and no shipped statement of its own
 * function around it is not an obligation. Tree-shaken code has no segment; a nested statement stays (decision 0016).
 */
export function builtStructure(compiler: FileCoverageJSON, bundle: FileCoverageJSON, emitted: ReadonlyArray<SourcePosition> = []): FileCoverageJSON {
  const json: FileCoverageJSON = { ...structuredClone(compiler), statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} }
  const order = (position: Partial<Position>) => [position.line ?? -1, position.column ?? -1] as const
  const before = (a: Partial<Position>, b: Partial<Position>) => order(a)[0] < order(b)[0] || (order(a)[0] === order(b)[0] && order(a)[1] <= order(b)[1])
  const start = (range: { start: Partial<Position> }) => JSON.stringify([range.start.line, range.start.column])
  const body = (fn: FileCoverageJSON["fnMap"][string]) => fn.loc ?? fn.decl
  const shippedFunctions = new Set(Object.values(bundle.fnMap).map(fn => start(body(fn))))
  const removedBodies = Object.values(compiler.fnMap).map(body).filter(loc => !shippedFunctions.has(start(loc)))
  const statements = Object.entries(compiler.statementMap)
  const replaced = new Set<string>()
  const matchedStarts = new Set<string>()
  for (const loc of Object.values(bundle.statementMap)) {
    const key = start(loc)
    if (matchedStarts.has(key)) continue
    matchedStarts.add(key)
    const exact = statements.filter(([, candidate]) => start(candidate) === start(loc))
    if (exact.length > 0) {
      for (const [id] of exact) replaced.add(id)
      continue
    }
    // Keep statements inside a removed nested function, even if its final expression shares the declaration's end.
    const candidates = statements.filter(([id, candidate]) => !replaced.has(id)
      && start({ start: candidate.end }) === start({ start: loc.end })
      && !removedBodies.some(range => before(range.start, candidate.start) && before(candidate.start, range.end)))
      .sort(([, a], [, b]) => before(a.start, b.start) ? -1 : 1)
    const preceding = candidates.filter(([, candidate]) => before(candidate.start, loc.start))
    const match = preceding.at(-1) ?? candidates[0]
    if (match) replaced.add(match[0])
  }
  const shipped = [...emitted].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const less = (position: SourcePosition, bound: Position) => position[0] < bound.line || (position[0] === bound.line && position[1] < (bound.column ?? -1))
  /** Whether the bundle emits code at a position in `[range.start, range.end)`: the first one at or after the start. */
  const shipsInside = (range: { start: Position; end: Position }) => {
    let low = 0
    let high = shipped.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (less(shipped[middle]!, range.start)) low = middle + 1
      else high = middle
    }
    const found = shipped[low]
    return found !== undefined && less(found, range.end)
  }
  const contains = (range: { start: Partial<Position>; end: Partial<Position> }, position: Position) => before(range.start, position) && !before(range.end, position)
  const shippedBodies = Object.values(bundle.fnMap).map(body)
  const shippedStatements = Object.values(bundle.statementMap)
  for (const [id, candidate] of statements) {
    if (replaced.has(id) || removedBodies.some(range => before(range.start, candidate.start) && before(candidate.start, range.end))) continue
    // Inlined, not nested: no shipped statement of its own function encloses it. A shipped `if` that holds this
    // statement as its consequent emits its code too, but cannot establish that it ran.
    const inner = shippedBodies.filter(range => contains(range, candidate.start)).sort((a, b) => before(a.start, b.start) ? 1 : -1)[0]
    const enclosed = shippedStatements.some(range => contains(range, candidate.start) && (inner === undefined || before(inner.start, range.start)))
    if (!enclosed && shipsInside(candidate)) replaced.add(id)
  }
  const seen = { s: new Set<string>(), f: new Set<string>(), b: new Set<string>() }
  const first = (kind: keyof typeof seen, key: string) => !seen[kind].has(key) && Boolean(seen[kind].add(key))
  // The minified bundle's map may start a later arm elsewhere (a ternary's second arm at its first arm's start, an
  // if/else printed as an `if`): its branch of the same kind, start and arm count replaces the compiler's.
  const shape = (branch: FileCoverageJSON["branchMap"][string]) => JSON.stringify([branch.type, start(branch.loc), branch.locations.length])
  const shippedBranches = new Set(Object.values(bundle.branchMap).map(shape))
  for (const owner of [bundle, compiler]) {
    for (const [id, loc] of Object.entries(owner.statementMap)) {
      if ((owner === compiler && replaced.has(id)) || !first("s", start(loc))) continue
      const key = String(Object.keys(json.statementMap).length)
      json.statementMap[key] = structuredClone(loc)
      json.s[key] = owner.s[id] ?? 0
    }
    for (const [id, fn] of Object.entries(owner.fnMap)) {
      if (!first("f", start(body(fn)))) continue
      const key = String(Object.keys(json.fnMap).length)
      json.fnMap[key] = structuredClone(fn)
      json.f[key] = owner.f[id] ?? 0
    }
    for (const [id, branch] of Object.entries(owner.branchMap)) {
      if ((owner === compiler && shippedBranches.has(shape(branch))) || !first("b", JSON.stringify([branch.type, branch.locations.map(start)]))) continue
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
