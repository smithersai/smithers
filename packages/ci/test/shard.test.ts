/**
 * Contract 8 against the label and shard pairs `smthrs --shard` is tested
 * with too (`packages/smithers/build/build-cli/test/Shards.test.ts`), so the
 * two implementations of the rule cannot disagree.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Shard } from "../src/index.ts"

interface Pair {
  readonly label: string
  readonly count: number
  readonly shard: number
}

const pairs = (JSON.parse(readFileSync(new URL("./fixtures/shard-labels.json", import.meta.url), "utf8")) as {
  readonly cases: ReadonlyArray<Pair>
}).cases

describe("contract 8: shards", () => {
  it.each(pairs)("puts $label in shard $shard of $count", ({ count, label, shard }) => {
    expect(Shard.shardOf(label, count)).toBe(shard)
  })

  it.each([1, 2, 3, 7, 9])("gives every label exactly one of %i shards", (count) => {
    const labels = [...new Set(pairs.map((pair) => pair.label))]
    const shards = Array.from({ length: count }, (_, index) => Shard.labelsOf(labels, { index, count }))
    expect(shards.flat().sort()).toEqual([...labels].sort())
  })
})
