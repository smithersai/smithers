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
