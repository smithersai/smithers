/**
 * Divides one run across machines.
 *
 * `--shard <index>/<count>` gives a machine the planned targets whose label
 * hashes to `index` among `count` shards: 32-bit FNV-1a over the label's
 * UTF-16 code units, modulo `count`. Every machine plans the same commit, so
 * each derives the same split with no coordinator. A machine runs its own
 * targets and every dependency they need; a dependency another shard owns is
 * replayed when the cache already holds it and run again when it does not.
 * The rule is the one `smithers-ci` declares in its `Shard` contract; both
 * packages test against the same label and shard pairs.
 *
 * `ci --remote` keeps a measured split: {@link split} balances the plan's
 * roots by the durations {@link measure} reads from earlier results files.
 *
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import type * as Executor from "../Executor.ts"
import type { PackagePlan } from "./PackageOptions.ts"

/**
 * One machine's share: shard `index` of `count`, counted from zero.
 *
 * @category models
 * @since 1.0.0
 */
export interface Shard {
  readonly index: number
  readonly count: number
}

/** A `--shard` or `--timings` input the run cannot use; the message names it and says why. */
class ShardRefused extends Data.TaggedError("smithers-build/ShardRefused")<{ readonly message: string }> {}

/** The most shards one run may have. */
const maxCount = 1024

/**
 * Parses `--shard <index>/<count>`, counted from zero.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parse = (text: string): Shard => {
  const match = /^(0|[1-9]\d{0,3})\/([1-9]\d{0,3})$/.exec(text)
  const index = Number(match?.[1])
  const count = Number(match?.[2])
  if (match === null || index >= count || count > maxCount) {
    throw new ShardRefused({
      message: `--shard expects <index>/<count> with 0 <= index < count <= ${maxCount}, received ${
        JSON.stringify(text)
      }`
    })
  }
  return { index, count }
}

/**
 * The shard a label belongs to among `count` shards: 32-bit FNV-1a over the
 * label's UTF-16 code units, modulo `count`.
 *
 * @category planning
 * @since 1.0.0
 */
export const shardOf = (label: string, count: number): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < label.length; index++) {
    hash ^= label.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % count
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Reads measured durations, in milliseconds by label, out of one
 * `--results-file` document and into `measured`.
 *
 * Only a target that ran counts: a cache hit's duration is the replay, a
 * skipped or cancelled target has none. A label a later document measures
 * again takes the later duration.
 *
 * @category parsing
 * @since 1.0.0
 */
export const measure = (source: string, content: string, measured: Map<string, number>): void => {
  let document: unknown
  try {
    document = JSON.parse(content)
  } catch (cause) {
    throw new ShardRefused({ message: `${source}: timings are not JSON (${(cause as Error).message})` })
  }
  if (!isRecord(document) || !Array.isArray(document["results"])) {
    throw new ShardRefused({ message: `${source}: timings need a results array, as --results-file writes` })
  }
  for (const [position, row] of (document["results"] as ReadonlyArray<unknown>).entries()) {
    if (!isRecord(row)) throw new ShardRefused({ message: `${source}: results[${position}] is not an object` })
    const { durationMs, label, status } = row
    if (typeof label !== "string" || typeof status !== "string") {
      throw new ShardRefused({ message: `${source}: results[${position}] needs a label and a status` })
    }
    if (status !== "ran" && status !== "failed") continue
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new ShardRefused({ message: `${source}: results[${position}] (${label}) needs a duration in milliseconds` })
    }
    measured.set(label, durationMs)
  }
}

/** The weight of every root: its measured duration, else the measured roots' median, else one. */
const weigh = (roots: ReadonlyArray<string>, measured: ReadonlyMap<string, number>): ReadonlyMap<string, number> => {
  const known = roots.flatMap((root) => {
    const duration = measured.get(root)
    return duration === undefined ? [] : [duration]
  }).sort((left, right) => left - right)
  const unmeasured = known.length === 0 ? 1 : known[Math.floor((known.length - 1) / 2)]!
  // A zero weight would let one part collect every instant target.
  return new Map(roots.map((root) => [root, Math.max(1, measured.get(root) ?? unmeasured)]))
}

/**
 * Splits roots into `count` parts of near-equal measured duration. Each part
 * keeps the plan's order; a part may be empty when there are fewer roots than
 * parts.
 *
 * @category planning
 * @since 1.0.0
 */
export const split = (
  roots: ReadonlyArray<string>,
  measured: ReadonlyMap<string, number>,
  count: number
): ReadonlyArray<ReadonlyArray<string>> => {
  const weights = weigh(roots, measured)
  const longestFirst = [...roots].sort((left, right) =>
    weights.get(right)! - weights.get(left)! || (left < right ? -1 : 1)
  )
  const totals = Array.from({ length: count }, () => 0)
  const part = new Map<string, number>()
  for (const root of longestFirst) {
    let lightest = 0
    for (let index = 1; index < count; index++) {
      if (totals[index]! < totals[lightest]!) lightest = index
    }
    totals[lightest]! += weights.get(root)!
    part.set(root, lightest)
  }
  return totals.map((_, index) => roots.filter((root) => part.get(root) === index))
}

/** The labels `shard` owns, in plan order, and the closure it runs: those labels and every dependency. */
const closureOf = (
  targets: ReadonlyArray<{ readonly label: string; readonly dependencies: ReadonlyArray<string> }>,
  shard: Shard
): { readonly owned: ReadonlyArray<string>; readonly closure: ReadonlySet<string> } => {
  const owned = targets.map(({ label }) => label).filter((label) => shardOf(label, shard.count) === shard.index)
  const dependencies = new Map(targets.map((target) => [target.label, target.dependencies]))
  const closure = new Set<string>()
  const pending = [...owned]
  while (pending.length > 0) {
    const label = pending.pop()!
    if (closure.has(label)) continue
    closure.add(label)
    pending.push(...dependencies.get(label)!)
  }
  return { owned, closure }
}

/**
 * The merged plan one shard runs. Its roots are the targets it owns; its
 * targets are those and exactly their dependency closure, in plan order.
 *
 * @category planning
 * @since 1.0.0
 */
export const select = (plan: Executor.MergedPlan, shard: Shard): Executor.MergedPlan => {
  const { closure, owned } = closureOf(plan.targets, shard)
  return {
    roots: owned,
    targets: plan.targets.filter((target) => closure.has(target.label)),
    edges: plan.edges.filter((edge) => closure.has(edge.to)),
    warnings: plan.warnings
  }
}

/**
 * The package plan one shard runs, by the same rule as {@link select}.
 * Nodes that are planned but never scheduled stay available to consumers.
 *
 * @category planning
 * @since 1.0.0
 */
export const selectPackage = (plan: PackagePlan, shard: Shard): PackagePlan => {
  const { closure, owned } = closureOf(plan.workList, shard)
  return { ...plan, roots: owned, workList: plan.workList.filter((node) => closure.has(node.label)) }
}
