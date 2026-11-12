import { balanceShards } from "@smthrs/targets/GithubCiGen"
import inventory from "../../../.smithers/target-index.json" with { type: "json" }
import timings from "./timings.json" with { type: "json" }

// Whole-package selections preserve wildcard policy (manual/exclusive targets
// stay excluded) and include future targets without maintaining a second roster.
// Dependencies can run in multiple jobs; roots have exactly one owner per lane.
const packages = [...new Set(inventory
  .filter((target) => target.package.startsWith("packages/") && target.kinds.some((kind) =>
    ["build", "test", "lint", "docs"].includes(kind)))
  .map((target) => `//${target.package}:*`))].sort()

const measured = Object.entries(timings.durationMs)
const tests = new Set(inventory.filter((target) => target.kinds.some((kind) => kind === "test") && !target.exclusive)
  .map((target) => target.label))
// A package's measured cost: every target (builds and private prerequisites
// included, which is conservative and covers cold dependency work), or its
// tests alone.
const cost = (pattern: string, testsOnly: boolean): number => measured
  .filter(([label]) => label.startsWith(pattern.slice(0, -1)) && (!testsOnly || tests.has(label)))
  .reduce((total, [, duration]) => total + duration, 0)
// One shard assignment serves both lanes: a workspace graph job runs every
// target of its packages and a package suite job runs their tests. So the
// balanced weight is the sum of the two lanes' work per package; balancing
// either lane alone leaves the other lane's shards uneven.
export const packageShards = balanceShards(packages.map((pattern) => ({
  pattern,
  durationMs: Math.max(1, cost(pattern, false) + cost(pattern, true))
})), 9)

export const shardJobId = (lane: "test" | "packages", index: number): string =>
  index === 0 ? lane : `${lane}-${index + 1}`

export const shardStep = (index: number) => ({
  pattern: packageShards[index]!.patterns[0]!,
  additionalPatterns: packageShards[index]!.patterns.slice(1),
  parallelism: 2
})
