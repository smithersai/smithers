import { basename } from "node:path"
import { parseDescription } from "./target"
import { SHIP_FEATURES, SHIP_TARGETS, shipFeaturesOf, type ShipTest, shipTestIdentity } from "./ship"

// The run's summary (docs/infrastructure.md#against-a-deployment): one line per spec with what passed, failed, skipped
// and why, and the run's verdict. A skip counts only when it names a declared need (e2e/target.ts); any other skip, a
// blocked need (the test account lacks a role) or a failure fails the run. A test marked broken (TEST-5) that fails is
// expected; one that passes fails the run, so its mark is removed.

/** How one test ended, as the summary counts it. */
export type Outcome =
  | { readonly kind: "passed" }
  | { readonly kind: "failed" }
  | { readonly kind: "broken"; readonly name: string }
  | { readonly kind: "fixed"; readonly name: string }
  | { readonly kind: "skipped"; readonly name: string; readonly reason: string }
  | { readonly kind: "blocked"; readonly name: string; readonly reason: string }
  | { readonly kind: "undeclared"; readonly reason: string }

type Annotation = { readonly type: string; readonly description?: string | undefined }

/** What the summary reads of a test: Playwright's `TestCase` and its last result, narrowed for unit tests. */
export type Ended = {
  readonly file: string
  readonly title: string
  /** Playwright project: ship acceptance requires receipts from every declared browser target. */
  readonly project?: string
  readonly name?: string
  readonly line?: number
  readonly column?: number
  readonly outcome: "skipped" | "expected" | "unexpected" | "flaky"
  readonly expectedStatus: string
  /** How its last run ended (`passed`, `failed`, `timedOut`, …), or `skipped` when it never ran. */
  readonly status: string
  readonly annotations: ReadonlyArray<Annotation>
}

const reasonOf = (description: string) => description.replace(/^(needs|blocked|broken) [A-Za-z]+: /, "")

export const outcomeOf = (test: Ended): Outcome => {
  const declared = (type: string) => {
    for (const annotation of test.annotations) {
      if (annotation.type !== type) continue
      const parsed = parseDescription(annotation.description)
      if (parsed !== undefined) return { ...parsed, reason: reasonOf(annotation.description!) }
    }
    return undefined
  }
  if (test.outcome === "skipped") {
    const need = declared("skip")
    if (need?.kind === "needs") return { kind: "skipped", name: need.name, reason: need.reason }
    if (need?.kind === "blocked") return { kind: "blocked", name: need.name, reason: need.reason }
    const said = test.annotations.find((annotation) => annotation.type === "skip")?.description
    return { kind: "undeclared", reason: said ?? "no reason given" }
  }
  if (test.expectedStatus === "failed") {
    // Marked broken (TEST-5): by `broken` (e2e/target.ts), or by a spec's own `test.fail`, named by its description.
    const mark = declared("fail")
    const name = mark?.kind === "broken" ? mark.name : (test.annotations.find((annotation) => annotation.type === "fail")?.description ?? "marked broken")
    if (test.outcome === "expected") return { kind: "broken", name }
    // Only a pass means the mark is stale; a timeout or another failure is a failure.
    return test.status === "passed" ? { kind: "fixed", name } : { kind: "failed" }
  }
  return test.outcome === "unexpected" ? { kind: "failed" } : { kind: "passed" }
}

export type Row = { readonly spec: string; readonly counts: Record<Outcome["kind"], number> }

const zero = (): Record<Outcome["kind"], number> => ({ passed: 0, failed: 0, broken: 0, fixed: 0, skipped: 0, blocked: 0, undeclared: 0 })

/** The run's verdict: per-spec counts, each skip reason with how many tests it skipped, and whether the run fails. */
export const summarize = (tests: ReadonlyArray<Ended>, options: { readonly shipAcceptance?: boolean; readonly inventory?: ReadonlyArray<ShipTest> } = {}) => {
  const rows = new Map<string, Row>()
  const reasons = new Map<string, number>()
  const failing: Array<string> = []
  // When the setup fails, Playwright runs nothing that depends on it: one line says so instead of one per test.
  const setupFailed = tests.some((test) => test.file.endsWith(".setup.ts") && outcomeOf(test).kind === "failed")
  let notRun = 0
  for (const test of tests) {
    const spec = basename(test.file)
    const row = rows.get(spec) ?? { spec, counts: zero() }
    rows.set(spec, row)
    const outcome = outcomeOf(test)
    row.counts[outcome.kind]++
    if (outcome.kind === "skipped" || outcome.kind === "blocked") {
      const key = `${outcome.kind === "blocked" ? "blocked" : "needs"} ${outcome.name}: ${outcome.reason}`
      reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
    // A test that ran without a part its target lacks (e2e/target.ts `partly`): listed, never hidden.
    for (const annotation of test.annotations) {
      if (annotation.type !== "partly" || parseDescription(annotation.description) === undefined) continue
      const key = `partly, ${annotation.description!}`
      reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
    if (outcome.kind === "failed") failing.push(`${spec}: ${test.title}: failed`)
    if (outcome.kind === "fixed") failing.push(`${spec}: ${test.title}: passes though marked broken ${outcome.name}; remove the mark`)
    if (outcome.kind === "undeclared" && setupFailed && test.annotations.length === 0) notRun++
    else if (outcome.kind === "undeclared") failing.push(`${spec}: ${test.title}: skipped without a declared need (${outcome.reason})`)
  }
  if (notRun > 0) failing.push(`${notRun} tests didn't run: the setup failed`)
  const total = zero()
  for (const row of rows.values()) for (const kind of Object.keys(total) as Array<Outcome["kind"]>) total[kind] += row.counts[kind]
  if (total.blocked > 0) failing.push(`${total.blocked} tests blocked: the run lacks a prerequisite (see "blocked" below)`)
  const acceptance = options.shipAcceptance === true ? shipResults(tests, options.inventory) : undefined
  if (acceptance !== undefined) failing.push(...acceptance.failing)
  return {
    rows: [...rows.values()].sort((left, right) => left.spec.localeCompare(right.spec)),
    total,
    reasons: [...reasons.entries()].sort((left, right) => right[1] - left[1]).map(([reason, count]) => ({ reason, count })),
    failing,
    passed: failing.length === 0,
    ...(acceptance === undefined ? {} : { acceptance: acceptance.receipts }),
  }
}

/** A ship receipt is an actual passed result, never an expected failure, an absent result or a partial journey. */
const shipSuccess = (test: Ended) =>
  outcomeOf(test).kind === "passed" && test.outcome === "expected" && test.status === "passed" && test.expectedStatus === "passed" &&
  !test.annotations.some((annotation) => annotation.type === "partly")

const shipResults = (tests: ReadonlyArray<Ended>, inventory: ReadonlyArray<ShipTest> | undefined) => {
  const failing: Array<string> = []
  if (inventory === undefined || inventory.length === 0) failing.push("Ship acceptance: no unfiltered test inventory")
  const succeeded = new Set(tests.filter(shipSuccess).map(shipTestIdentity))
  for (const test of inventory ?? []) {
    if (!succeeded.has(shipTestIdentity(test))) failing.push(`Ship acceptance: ${basename(test.file)} [${test.project ?? "unknown target"}]: ${test.title}: collected journey has no executed success`)
  }
  for (const test of tests) {
    if (shipFeaturesOf(test.file).length === 0 || shipSuccess(test)) continue
    failing.push(`Ship acceptance: ${basename(test.file)} [${test.project ?? "unknown target"}]: ${test.title}: requires executed success (${test.status})`)
  }
  const receipts = SHIP_FEATURES.flatMap((feature) => feature.specs.flatMap((spec) => SHIP_TARGETS.map((project) => {
    const executed = tests.filter((test) => basename(test.file) === spec && test.project === project && shipSuccess(test)).length
    if (executed === 0) failing.push(`Ship acceptance: ${feature.id} ${feature.feature}: ${spec} [${project}]: no executed success`)
    if (!inventory?.some((test) => basename(test.file) === spec && test.project === project)) failing.push(`Ship acceptance: ${spec} [${project}]: absent from unfiltered inventory`)
    return { feature: feature.id, spec, project, executed }
  })))
  return { failing, receipts }
}

const COLUMNS: ReadonlyArray<Outcome["kind"]> = ["passed", "failed", "broken", "fixed", "skipped", "blocked", "undeclared"]

/** The summary as text: a table, the skip reasons, then what failed the run. */
export const render = (summary: ReturnType<typeof summarize>) => {
  const width = Math.max(5, ...summary.rows.map((row) => row.spec.length))
  const line = (spec: string, cells: ReadonlyArray<string | number>) => `${spec.padEnd(width)}  ${cells.map((cell) => String(cell).padStart(12)).join("")}`
  return [
    line("spec", COLUMNS),
    ...summary.rows.map((row) => line(row.spec, COLUMNS.map((kind) => (row.counts[kind] === 0 ? "·" : row.counts[kind])))),
    line("total", COLUMNS.map((kind) => summary.total[kind])),
    "",
    ...summary.reasons.map(({ reason, count }) => `${String(count).padStart(4)} × ${reason}`),
    "",
    ...(summary.passed ? ["Run passed."] : ["Run failed:", ...summary.failing.map((reason) => `  - ${reason}`)]),
  ].join("\n")
}
