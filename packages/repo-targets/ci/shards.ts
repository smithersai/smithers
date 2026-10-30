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
export const packageShards = balanceShards(packages.map((pattern) => ({
  pattern,
  // Include measured private prerequisites and builds in both lanes. This is
  // conservative for test-only jobs, and accounts for cold dependency work.
  durationMs: Math.max(1, measured.filter(([label]) => label.startsWith(pattern.slice(0, -1)))
    .reduce((total, [, duration]) => total + duration, 0))
})), 8)

export const shardJobId = (lane: "test" | "packages", index: number): string =>
  index === 0 ? lane : `${lane}-${index + 1}`

export const shardStep = (index: number) => ({
  pattern: packageShards[index]!.patterns[0]!,
  additionalPatterns: packageShards[index]!.patterns.slice(1),
  parallelism: 2
})
