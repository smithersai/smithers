/**
 * Contract 8: dividing one run across machines.
 *
 * Every machine computes the same plan and takes the targets whose label
 * hashes to its index. A machine runs its own targets and any dependency that
 * is not already a cache hit; machines share results only through the cache.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * One machine's share: shard `index` of `count`, counted from 0.
 *
 * @category models
 * @since 0.1.0
 */
export const Shard = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
})

/**
 * A decoded `Shard`.
 *
 * @category models
 * @since 0.1.0
 */
export type Shard = typeof Shard.Type

/**
 * The shard a label belongs to among `count` shards: 32-bit FNV-1a over the
 * label's UTF-16 code units, modulo `count`. Pure, so every machine agrees
 * without talking to another.
 *
 * @category accessors
 * @since 0.1.0
 */
export const shardOf = (label: string, count: number): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < label.length; index++) {
    hash ^= label.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % count
}

/**
 * The labels of `labels` that belong to `shard`, in their given order.
 *
 * @category accessors
 * @since 0.1.0
 */
export const labelsOf = (labels: ReadonlyArray<string>, shard: Shard): ReadonlyArray<string> =>
  labels.filter((label) => shardOf(label, shard.count) === shard.index)

/**
 * The shard of every label when durations are known: the longest label goes
 * first, each onto the shard with the least time so far. A label with no
 * measured duration goes where `shardOf` puts it. Every machine reading the
 * same durations computes the same answer.
 *
 * @category accessors
 * @since 0.1.0
 */
export const assign = (
  labels: ReadonlyArray<string>,
  count: number,
  durations: Readonly<Record<string, number>>
): ReadonlyMap<string, number> => {
  const weight = (label: string): number => {
    const duration = Object.hasOwn(durations, label) ? Number(durations[label]) : 0
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  }
  const loads = Array.from({ length: count }, () => 0)
  const lightest = (): number => loads.reduce((best, load, index) => load < Number(loads[best]) ? index : best, 0)
  const ordered = [...new Set(labels)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))
  const assigned = new Map<string, number>()
  for (const label of ordered) {
    const index = weight(label) > 0 ? lightest() : shardOf(label, count)
    loads[index] = Number(loads[index]) + weight(label)
    assigned.set(label, index)
  }
  return assigned
}
