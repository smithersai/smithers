import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import * as Yaml from "yaml"
import { packageShards, shardJobId, shardStep } from "../ci/shards.ts"
import timings from "../ci/timings.json" with { type: "json" }

type Job = { steps: Array<{ name?: string; run?: string; if?: string }>; needs?: unknown; "timeout-minutes": number }
const ci = () => Yaml.parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
  jobs: Record<string, Job>
}
const inventory = JSON.parse(readFileSync(new URL("../../../.smithers/target-index.json", import.meta.url), "utf8")) as Array<{
  package: string; label: string; kinds: Array<string>; exclusive?: boolean
}>
const roots = [...new Set(inventory.filter((row) => row.package.startsWith("packages/") &&
  row.kinds.some((kind) => ["build", "test", "lint", "docs"].includes(kind))).map((row) => `//${row.package}:*`))].sort()
const weights = new Map(roots.map((pattern) => [pattern, Object.entries(timings.durationMs)
  .filter(([label]) => label.split(":")[0] === pattern.slice(0, -2)).reduce((sum, [, duration]) => sum + duration, 0)]))
const testLabels = new Set(inventory.filter((row) => row.kinds.includes("test") && !row.exclusive).map((row) => row.label))
const testWeights = new Map(roots.map((pattern) => [pattern, Object.entries(timings.durationMs)
  .filter(([label]) => label.split(":")[0] === pattern.slice(0, -2) && testLabels.has(label))
  .reduce((sum, [, duration]) => sum + duration, 0)]))

type Lane = "test" | "packages"
type Costs = { readonly all: ReadonlyMap<string, number>; readonly tests: ReadonlyMap<string, number> }
const stepName = (lane: Lane) => lane === "test" ? "Workspace targets" : "Package test targets"

// A spread bound measures how evenly the balancer split divisible work. A
// heaviest shard holding one package root cannot get lighter under any split,
// so the bound then applies to the other shards; a heaviest shard holding two
// or more roots is held to it against every shard. Each measure finds its own
// heaviest shard.
const spread = (costs: ReadonlyArray<number>, rootCounts: ReadonlyArray<number>): number => {
  const heaviest = costs.indexOf(Math.max(...costs))
  const compared = rootCounts[heaviest] === 1 ? costs.filter((_, index) => index !== heaviest) : costs
  return Math.max(...compared) - Math.min(...compared)
}

function verify(jobs: Record<string, Job>, lane: Lane, costs: Costs = { all: weights, tests: testWeights }) {
  const selections: Array<string> = []
  const rootCounts: Array<number> = []
  const testDurations: Array<number> = []
  const durations = packageShards.map((_, index) => {
    const id = shardJobId(lane, index)
    const job = jobs[id]!
    assert.ok(job, `missing ${id}`)
    assert.equal(job.needs, undefined)
    assert.equal(job["timeout-minutes"], 40)
    const steps = job.steps.filter((step) => step.name === stepName(lane))
    assert.equal(steps.length, 1)
    const command = steps[0]!.run!
    assert.ok(command.startsWith(`pnpm exec smthrs ${lane === "test" ? "ci" : "test"} `))
    assert.ok(command.includes("--jobs 2 --known-red '.github/ci-known-red.json' --results-file"))
    assert.ok(command.endsWith("--verbose"))
    assert.equal(steps[0]!.if, "${{ !cancelled() && steps.setup.conclusion == 'success' }}")
    const patterns = [...command.matchAll(/'(\/\/[^']+)'/g)].map((match) => match[1]!)
    assert.ok(patterns.length > 0)
    selections.push(...patterns)
    rootCounts.push(patterns.length)
    testDurations.push(patterns.reduce((sum, pattern) => sum + costs.tests.get(pattern)!, 0))
    return patterns.reduce((sum, pattern) => sum + costs.all.get(pattern)!, 0)
  })
  assert.equal(Object.keys(jobs).filter((id) => id === lane || id.startsWith(`${lane}-`)).length, 9)
  // Package selections are nonrecursive and disjoint. Hence each target root
  // has exactly one owner, with the CLI's manual/exclusive/host policy intact.
  assert.deepEqual(selections.sort(), roots, "missing or duplicated target ownership")
  assert.ok(Math.max(...durations) <= 32 * 60_000, "shard exceeds 32 measured target-minutes")
  assert.ok(spread(durations, rootCounts) <= 3 * 60_000, "shards differ by over three target-minutes")
  if (lane === "packages") {
    assert.ok(Math.max(...testDurations) <= 32 * 60_000, "test shard exceeds 32 measured target-minutes")
    assert.ok(spread(testDurations, rootCounts) <= 4 * 60_000, "test shards differ by over four target-minutes")
  }
}

/** The generated lane, with each job's package selection replaced by one entry of `layout`. */
const relaid = (lane: Lane, layout: ReadonlyArray<ReadonlyArray<string>>): Record<string, Job> => {
  const jobs = ci().jobs
  for (const [index, patterns] of layout.entries()) {
    const step = jobs[shardJobId(lane, index)]!.steps.find((step) => step.name === stepName(lane))!
    step.run = step.run!.replace(/(?: '\/\/[^']+')+/, patterns.map((pattern) => ` '${pattern}'`).join(""))
  }
  return jobs
}

/** `first` as the first shard, and every other root dealt over the remaining shards. */
const layoutWith = (first: ReadonlyArray<string>): Array<Array<string>> => {
  const rest = roots.filter((pattern) => !first.includes(pattern))
  const others = packageShards.length - 1
  return [[...first], ...Array.from({ length: others }, (_, shard) => rest.filter((_, index) => index % others === shard))]
}

/** Per-shard totals in minutes: the first shard, the others, and optionally a lighter last shard. */
const totals = (first: number, others: number, last = others): Array<number> =>
  [first, ...Array.from({ length: packageShards.length - 2 }, () => others), last]

/** Root costs that split each shard's total evenly over its roots. */
const costsOf = (layout: ReadonlyArray<ReadonlyArray<string>>, minutes: ReadonlyArray<number>) =>
  new Map(layout.flatMap((patterns, index) =>
    patterns.map((pattern) => [pattern, minutes[index]! * 60_000 / patterns.length] as const)))

it("both generated lanes cover every target once and stay inside the measured balance bounds", () => {
  verify(ci().jobs, "test")
  verify(ci().jobs, "packages")
  for (const [index, shard] of packageShards.entries()) {
    expect(shardStep(index)).toEqual({
      pattern: shard.patterns[0], additionalPatterns: shard.patterns.slice(1), parallelism: 2
    })
  }
  const measurements = new Set(Object.keys(timings.durationMs))
  // A new unmeasured target requires timing evidence, rather than silently
  // assigning zero cost. The recorded exceptions are manual Jev gates, excluded by wildcard selection.
  expect(inventory.filter((row) => row.package.startsWith("packages/") && !row.exclusive &&
    row.kinds.some((kind) => ["build", "test", "lint", "docs"].includes(kind)) && !measurements.has(row.label))
    .map((row) => row.label).sort()).toEqual(timings.unmeasuredTargets)
})

it("rejects a missing job, a dropped target, a duplicate and a complete but unbalanced split", () => {
  const missing = ci().jobs
  delete missing.test
  expect(() => verify(missing, "test")).toThrow(/missing test/)
  const dropped = ci().jobs
  const step = dropped.test!.steps.find((step) => step.name === "Workspace targets")!
  const pattern = step.run!.match(/'(\/\/[^']+)'/)![0]
  step.run = step.run!.replace(pattern, "")
  expect(() => verify(dropped, "test")).toThrow()
  const duplicated = ci().jobs
  const duplicate = duplicated["test-2"]!.steps.find((step) => step.name === "Workspace targets")!
  duplicate.run = duplicate.run!.replace(" --jobs", ` ${pattern} --jobs`)
  expect(() => verify(duplicated, "test")).toThrow(/ownership/)
  const unbalanced = ci().jobs
  const destination = unbalanced.test!.steps.find((step) => step.name === "Workspace targets")!
  for (let index = 1; index < packageShards.length; index++) {
    const source = unbalanced[shardJobId("test", index)]!.steps.find((step) => step.name === "Workspace targets")!
    const move = source.run!.match(/'(\/\/[^']+)'/)![0]
    source.run = source.run!.replace(move, "")
    destination.run = destination.run!.replace(" --jobs", ` ${move} --jobs`)
  }
  expect(() => verify(unbalanced, "test")).toThrow(/target-minutes/)
  // This move keeps combined costs within three minutes but separates test
  // costs by over four: the package lane must check its own workload too.
  const testOnly = ci().jobs
  const from = testOnly["packages-7"]!.steps.find((step) => step.name === "Package test targets")!
  const to = testOnly["packages-2"]!.steps.find((step) => step.name === "Package test targets")!
  const move = "'//packages/smithers/agent/harness:*'"
  from.run = from.run!.replace(move, "")
  to.run = to.run!.replace(" --jobs", ` ${move} --jobs`)
  expect(() => verify(testOnly, "packages")).toThrow(/test shards differ/)
})

it("excuses only an irreducible single-root heaviest shard from the spread bounds", () => {
  // One root alone outweighs every other shard by more than either bound
  // (4 and 4.5 target-minutes), and the other shards are even: no split can do better.
  const single = layoutWith([roots[0]!])
  const irreducible = { all: costsOf(single, totals(31, 27)), tests: costsOf(single, totals(30, 25.5)) }
  expect(() => verify(relaid("packages", single), "packages", irreducible)).not.toThrow()
  // The same totals with two roots in the heaviest shard: a split could have evened it.
  const paired = layoutWith([roots[0]!, roots[1]!])
  expect(() => verify(relaid("packages", paired), "packages", {
    all: costsOf(paired, totals(31, 27)), tests: costsOf(paired, totals(30, 27))
  })).toThrow(/shards differ by over three/)
  // An irreducible heaviest shard does not excuse uneven remaining shards, in either measure.
  expect(() => verify(relaid("packages", single), "packages", { ...irreducible, all: costsOf(single, totals(31, 27, 23.5)) }))
    .toThrow(/shards differ by over three/)
  expect(() => verify(relaid("packages", single), "packages", { ...irreducible, tests: costsOf(single, totals(30, 25.5, 21)) }))
    .toThrow(/test shards differ by over four/)
  // Each measure finds its own heaviest shard: the single root is heaviest
  // overall but lightest in tests, so every shard counts toward the test spread.
  expect(() => verify(relaid("packages", single), "packages", { ...irreducible, tests: costsOf(single, totals(20, 24.5)) }))
    .toThrow(/test shards differ by over four/)
})
