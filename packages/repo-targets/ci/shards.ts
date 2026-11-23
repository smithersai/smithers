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
// The package suites run `smthrs test`, which refuses a label that names no test (where `//pkg:*` passes over it), so
// a split package gives that lane its test labels alone.
export const packageLanePatterns: ReadonlyArray<string> = packagePatterns.filter((pattern) =>
  pattern.endsWith(":*") ||
  inventory.some((target) => target.label === pattern && target.kinds.some((kind) => kind === "test")))

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
const work = new Map(packageLanePatterns.map((pattern) => [pattern, cost(pattern, false)]))
const testWork = new Map(packageLanePatterns.map((pattern) => [pattern, cost(pattern, true)]))
const weight = (pattern: string): number => Math.max(1, work.get(pattern)! + testWork.get(pattern)!)

/** How far apart the shards are in one measure; a heaviest shard of one selection cannot be split, so it is left out. */
const spreadOfSums = (sums: ReadonlyArray<number>, counts: ReadonlyArray<number>): number => {
  let maxVal = -Infinity
  let heaviest = 0
  for (let i = 0; i < sums.length; i++) {
    const v = sums[i]!
    if (v > maxVal) {
      maxVal = v
      heaviest = i
    }
  }
  const skipHeaviest = counts[heaviest] === 1
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < sums.length; i++) {
    if (skipHeaviest && i === heaviest) continue
    const v = sums[i]!
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return hi - lo
}

/** The wider of the two spreads, each against its bound in CiShards.test.ts: 3 minutes of all work, 4 of tests. */
const unevennessSums = (
  workSums: ReadonlyArray<number>,
  testSums: ReadonlyArray<number>,
  counts: ReadonlyArray<number>
): number => Math.max(spreadOfSums(workSums, counts) / 180_000, spreadOfSums(testSums, counts) / 240_000)

/**
 * Longest-first scheduling evens one weight, a selection's work in both lanes, and can still leave one lane's work
 * uneven where large selections stay whole (the four parts of //packages/ci:test). From there one selection is moved,
 * or two are swapped, between two shards while that narrows the wider spread; each step narrows it, so it ends.
 */
const evened = (start: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<ReadonlyArray<string>> => {
  const layout = start.map((patterns) => [...patterns])
  const shardCount = layout.length
  const workSums = layout.map((patterns) => patterns.reduce((sum, pattern) => sum + work.get(pattern)!, 0))
  const testSums = layout.map((patterns) => patterns.reduce((sum, pattern) => sum + testWork.get(pattern)!, 0))
  const counts = layout.map((patterns) => patterns.length)
  while (true) {
    let bestScore = unevennessSums(workSums, testSums, counts)
    let bestFrom = -1
    let bestTo = -1
    let bestMovedIndex = -1
    let bestBackIndex = -1
    for (let from = 0; from < shardCount; from++) {
      const source = layout[from]!
      if (source.length < 2) continue
      for (let to = 0; to < shardCount; to++) {
        if (to === from) continue
        const target = layout[to]!
        for (let mIdx = 0; mIdx < source.length; mIdx++) {
          const moved = source[mIdx]!
          const mw = work.get(moved)!
          const mt = testWork.get(moved)!
          // Candidate 1: move `moved` from `from` -> `to` without swap
          workSums[from] = workSums[from]! - mw
          workSums[to] = workSums[to]! + mw
          testSums[from] = testSums[from]! - mt
          testSums[to] = testSums[to]! + mt
          counts[from] = counts[from]! - 1
          counts[to] = counts[to]! + 1
          const moveScore = unevennessSums(workSums, testSums, counts)
          if (moveScore < bestScore - 1e-9) {
            bestScore = moveScore
            bestFrom = from
            bestTo = to
            bestMovedIndex = mIdx
            bestBackIndex = -1
          }
          // Candidate 2: swap `moved` with each `back` in `target`
          counts[from] = counts[from]! + 1
          counts[to] = counts[to]! - 1
          for (let bIdx = 0; bIdx < target.length; bIdx++) {
            const back = target[bIdx]!
            const bw = work.get(back)!
            const bt = testWork.get(back)!
            workSums[from] = workSums[from]! + bw
            workSums[to] = workSums[to]! - bw
            testSums[from] = testSums[from]! + bt
            testSums[to] = testSums[to]! - bt
            const swapScore = unevennessSums(workSums, testSums, counts)
            if (swapScore < bestScore - 1e-9) {
              bestScore = swapScore
              bestFrom = from
              bestTo = to
              bestMovedIndex = mIdx
              bestBackIndex = bIdx
            }
            workSums[from] = workSums[from]! - bw
            workSums[to] = workSums[to]! + bw
            testSums[from] = testSums[from]! - bt
            testSums[to] = testSums[to]! + bt
          }
          workSums[from] = workSums[from]! + mw
          workSums[to] = workSums[to]! - mw
          testSums[from] = testSums[from]! + mt
          testSums[to] = testSums[to]! - mt
        }
      }
    }
    if (bestFrom === -1) return layout.map((patterns) => patterns.sort())
    const moved = layout[bestFrom]!.splice(bestMovedIndex, 1)[0]!
    const mw = work.get(moved)!
    const mt = testWork.get(moved)!
    workSums[bestFrom] = workSums[bestFrom]! - mw
    workSums[bestTo] = workSums[bestTo]! + mw
    testSums[bestFrom] = testSums[bestFrom]! - mt
    testSums[bestTo] = testSums[bestTo]! + mt
    if (bestBackIndex >= 0) {
      const back = layout[bestTo]!.splice(bestBackIndex, 1)[0]!
      const bw = work.get(back)!
      const bt = testWork.get(back)!
      layout[bestFrom]!.push(back)
      workSums[bestFrom] = workSums[bestFrom]! + bw
      workSums[bestTo] = workSums[bestTo]! - bw
      testSums[bestFrom] = testSums[bestFrom]! + bt
      testSums[bestTo] = testSums[bestTo]! - bt
    } else {
      counts[bestFrom] = counts[bestFrom]! - 1
      counts[bestTo] = counts[bestTo]! + 1
    }
    layout[bestTo]!.push(moved)
  }
}

// The package suite jobs split the packages by measured cost. A package
// weighs its workspace-lane work (every target) plus its package-lane work
// (its tests), so the split stays even if the workspace graph moves back to it.
export const packageShards = evened(
  balanceShards(packageLanePatterns.map((pattern) => ({ pattern, durationMs: weight(pattern) })), 9)
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
