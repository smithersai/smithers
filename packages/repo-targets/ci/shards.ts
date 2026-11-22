import { balanceShards } from "@smthrs/targets/GithubCiGen"
import inventory from "../../../.smithers/target-index.json" with { type: "json" }
import timings from "./timings.json" with { type: "json" }

// Whole-package selections preserve wildcard policy (manual/exclusive targets
// stay excluded) and include future targets without maintaining a second roster.
// Dependencies can run in multiple jobs; roots have exactly one owner per lane.
const eligible = (target: (typeof inventory)[number]) =>
  target.package.startsWith("packages/") && target.kinds.some((kind) => ["build", "test", "lint", "docs"].includes(kind))
// A package whose suite runs in parts (its `test` is an exclusive Suite over them, as //packages/ci:test is) is
// selected target by target instead: each part is a root of its own, so the balancer can put the parts in different
// jobs. Its exclusive targets stay out, as a wildcard leaves them out.
const splitPackages = new Set(inventory.filter((target) => eligible(target) && target.rule === "Suite" &&
  "exclusive" in target && target.exclusive === true).map((target) => target.package))
export const packagePatterns: ReadonlyArray<string> = [...new Set(inventory.filter(eligible).flatMap((target) =>
  !splitPackages.has(target.package) ? [`//${target.package}:*`] :
  "exclusive" in target && target.exclusive === true ? [] : [target.label]))].sort()

const measured = Object.entries(timings.durationMs)
const tests = new Set(inventory.filter((target) => target.kinds.some((kind) => kind === "test") && !target.exclusive)
  .map((target) => target.label))
// A package's measured cost: every target (builds and private prerequisites
// included, which is conservative and covers cold dependency work), or its
// tests alone.
const owns = (pattern: string, label: string): boolean =>
  pattern.endsWith(":*") ? label.startsWith(pattern.slice(0, -1)) : label === pattern
const cost = (pattern: string, testsOnly: boolean): number => measured
  .filter(([label]) => owns(pattern, label) && (!testsOnly || tests.has(label)))
  .reduce((total, [, duration]) => total + duration, 0)
const work = new Map(packagePatterns.map((pattern) => [pattern, cost(pattern, false)]))
const testWork = new Map(packagePatterns.map((pattern) => [pattern, cost(pattern, true)]))
const weight = (pattern: string): number => Math.max(1, work.get(pattern)! + testWork.get(pattern)!)

/** How far apart the shards are in one measure; a heaviest shard of one selection cannot be split, so it is left out. */
const spreadOf = (layout: ReadonlyArray<ReadonlyArray<string>>, measure: ReadonlyMap<string, number>): number => {
  const costs = layout.map((patterns) => patterns.reduce((sum, pattern) => sum + measure.get(pattern)!, 0))
  const heaviest = costs.indexOf(Math.max(...costs))
  const compared = layout[heaviest]!.length === 1 ? costs.filter((_, index) => index !== heaviest) : costs
  return Math.max(...compared) - Math.min(...compared)
}

/** The wider of the two spreads, each against its bound in CiShards.test.ts: 3 minutes of all work, 4 of tests. */
const unevenness = (layout: ReadonlyArray<ReadonlyArray<string>>): number =>
  Math.max(spreadOf(layout, work) / 180_000, spreadOf(layout, testWork) / 240_000)

/**
 * Longest-first scheduling evens one weight, a selection's work in both lanes, and can still leave one lane's work
 * uneven where large selections stay whole (the four parts of //packages/ci:test). From there one selection is moved,
 * or two are swapped, between two shards while that narrows the wider spread; each step narrows it, so it ends.
 */
const evened = (start: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<ReadonlyArray<string>> => {
  let layout = start.map((patterns) => [...patterns])
  while (true) {
    let best: { readonly score: number; readonly layout?: Array<Array<string>> } = { score: unevenness(layout) }
    for (const [from, source] of layout.entries()) {
      if (source.length < 2) continue
      for (const to of layout.keys()) {
        if (to === from) continue
        for (const moved of source) {
          for (const back of [undefined, ...layout[to]!]) {
            const next = layout.map((patterns) => [...patterns])
            next[from] = next[from]!.filter((pattern) => pattern !== moved)
            next[to]!.push(moved)
            if (back !== undefined) {
              next[to] = next[to]!.filter((pattern) => pattern !== back)
              next[from]!.push(back)
            }
            const score = unevenness(next)
            if (score < best.score - 1e-9) best = { score, layout: next }
          }
        }
      }
    }
    if (best.layout === undefined) return layout.map((patterns) => patterns.sort())
    layout = best.layout
  }
}

// The package suite jobs split the packages by measured cost. A package
// weighs its workspace-lane work (every target) plus its package-lane work
// (its tests), so the split stays even if the workspace graph moves back to it.
export const packageShards = evened(
  balanceShards(packagePatterns.map((pattern) => ({ pattern, durationMs: weight(pattern) })), 9)
    .map((shard) => shard.patterns)
).map((patterns) => ({ patterns, durationMs: patterns.reduce((sum, pattern) => sum + weight(pattern), 0) }))

export const shardJobId = (lane: "test" | "packages", index: number): string =>
  index === 0 ? lane : `${lane}-${index + 1}`

export const shardStep = (index: number) => ({
  pattern: packageShards[index]!.patterns[0]!,
  additionalPatterns: packageShards[index]!.patterns.slice(1),
  parallelism: 2
})

/**
 * The workspace graph job: one matrix job whose every machine plans all
 * package selections and runs `ci --shard <index>/9`, the targets whose label
 * hashes to its shard and their dependencies.
 */
export const workspaceShards = 9

export const workspaceStep = {
  pattern: packagePatterns[0]!,
  additionalPatterns: packagePatterns.slice(1),
  parallelism: 2
}
