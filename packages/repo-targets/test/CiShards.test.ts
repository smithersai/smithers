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

function verify(jobs: Record<string, Job>, lane: "test" | "packages") {
  const selections: Array<string> = []
  const testDurations: Array<number> = []
  const durations = packageShards.map((_, index) => {
    const id = shardJobId(lane, index)
    const job = jobs[id]!
    assert.ok(job, `missing ${id}`)
    assert.equal(job.needs, undefined)
    assert.equal(job["timeout-minutes"], 40)
    const steps = job.steps.filter((step) => step.name === (lane === "test" ? "Workspace targets" : "Package test targets"))
    assert.equal(steps.length, 1)
    const command = steps[0]!.run!
    assert.ok(command.startsWith(`pnpm exec smthrs ${lane === "test" ? "ci" : "test"} `))
    assert.ok(command.includes("--jobs 2 --known-red '.github/ci-known-red.json' --results-file"))
    assert.ok(command.endsWith("--verbose"))
    assert.equal(steps[0]!.if, "${{ !cancelled() && steps.setup.conclusion == 'success' }}")
    const patterns = [...command.matchAll(/'(\/\/[^']+)'/g)].map((match) => match[1]!)
    assert.ok(patterns.length > 0)
    selections.push(...patterns)
    testDurations.push(patterns.reduce((sum, pattern) => sum + testWeights.get(pattern)!, 0))
    return patterns.reduce((sum, pattern) => sum + weights.get(pattern)!, 0)
  })
  assert.equal(Object.keys(jobs).filter((id) => id === lane || id.startsWith(`${lane}-`)).length, 8)
  // Package selections are nonrecursive and disjoint. Hence each target root
  // has exactly one owner, with the CLI's manual/exclusive/host policy intact.
  assert.deepEqual(selections.sort(), roots, "missing or duplicated target ownership")
  assert.ok(Math.max(...durations) <= 32 * 60_000, "shard exceeds 32 measured target-minutes")
  assert.ok(Math.max(...durations) - Math.min(...durations) <= 3 * 60_000, "shards differ by over three target-minutes")
  if (lane === "packages") {
    assert.ok(Math.max(...testDurations) <= 32 * 60_000, "test shard exceeds 32 measured target-minutes")
    assert.ok(Math.max(...testDurations) - Math.min(...testDurations) <= 4 * 60_000,
      "test shards differ by over four target-minutes")
  }
}

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
  const from = testOnly["packages-6"]!.steps.find((step) => step.name === "Package test targets")!
  const to = testOnly.packages!.steps.find((step) => step.name === "Package test targets")!
  const move = "'//packages/smithers/build/infra:*'"
  from.run = from.run!.replace(move, "")
  to.run = to.run!.replace(" --jobs", ` ${move} --jobs`)
  expect(() => verify(testOnly, "packages")).toThrow(/test shards differ/)
})
