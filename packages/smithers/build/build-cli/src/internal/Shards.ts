/**
 * Splits a CI plan across machines by measured duration.
 *
 * `ci --shard 2/6` runs the second of six parts of the selected roots. Every
 * machine plans the same commit with the same `--timings` files, so each
 * derives the same split with no coordinator: the split is a pure function of
 * the plan's roots and the measured durations.
 *
 * A root weighs the time it last took to run. A root no file measured weighs
 * the median of the measured roots, so a new target is neither free nor the
 * longest. Roots are placed longest first, each on the lightest part so far.
 * A dependency several parts need runs in each of them unless a shared cache
 * replays it.
 *
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import type * as Executor from "../Executor.ts"

/**
 * One part of a split: `index` of `count`, counted from one.
 *
 * @category models
 * @since 1.0.0
 */
export interface Shard {
  readonly index: number
  readonly count: number
}

/** A `--shard` or `--timings` input the split cannot use; the message names it and says why. */
class ShardRefused extends Data.TaggedError("smithers-build/ShardRefused")<{ readonly message: string }> {}

/** The most parts one split may have. */
const maxCount = 1024

/**
 * Parses `--shard <index>/<count>`.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parse = (text: string): Shard => {
  const match = /^([1-9]\d{0,3})\/([1-9]\d{0,3})$/.exec(text)
  const index = Number(match?.[1])
  const count = Number(match?.[2])
  if (match === null || index > count || count > maxCount) {
    throw new ShardRefused({
      message: `--shard expects <index>/<count> with 1 <= index <= count <= ${maxCount}, received ${
        JSON.stringify(text)
      }`
    })
  }
  return { index, count }
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
    weights.get(right)! - weights.get(left)! || (left < right ? -1 : left > right ? 1 : 0)
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

/**
 * The plan one shard runs: its roots and exactly their dependency closure, in
 * the plan's order.
 *
 * @category planning
 * @since 1.0.0
 */
export const select = (
  plan: Executor.MergedPlan,
  shard: Shard,
  measured: ReadonlyMap<string, number>
): Executor.MergedPlan => {
  const roots = split(plan.roots, measured, shard.count)[shard.index - 1]!
  const dependencies = new Map(plan.targets.map((target) => [target.label, target.dependencies]))
  const closure = new Set<string>()
  const pending = [...roots]
  while (pending.length > 0) {
    const label = pending.pop()!
    if (closure.has(label)) continue
    closure.add(label)
    pending.push(...dependencies.get(label)!)
  }
  return {
    roots,
    targets: plan.targets.filter((target) => closure.has(target.label)),
    edges: plan.edges.filter((edge) => closure.has(edge.to)),
    warnings: plan.warnings
  }
}
