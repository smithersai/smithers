import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { RunRecord } from "../../src/contract/RunRecord.vibe"
import { assign, fnv1a32, labelsOf, Shard, shardOf } from "../../src/contract/Shard.vibe"

describe("shard limits", () => {
  it.each([0, -1, 2.5, Infinity, NaN])("rejects invalid count %s even for an empty plan", (count) => {
    expect(() => shardOf("test", count)).toThrow()
    expect(() => assign([], count, {})).toThrow()
    expect(() => labelsOf([], { count, index: 0 })).toThrow()
  })

  it.each([-1, 2, 3])("rejects index %i for two shards on input and in a persisted run", (index) => {
    const shard = { count: 2, index }
    expect(labelsOf(["a"], shard)).toEqual([])
    expect(Schema.is(Shard)(shard)).toBe(false)
    expect(Schema.is(RunRecord)({ ok: true, results: [], counts: { hit: 0, ran: 0, failed: 0, skipped: 0 }, shard }))
      .toBe(false)
  })

  it("needs balancing storage only for measured labels, even at the full 32-bit hash modulus", () => {
    const count = 2 ** 32
    expect(fnv1a32("a")).toBe(0xe40c292c)
    expect(shardOf("a", count)).toBe(fnv1a32("a"))
    expect([...assign([], count, {})]).toEqual([])
    expect([...assign(["a", "short", "long"], count, { short: 1, long: 9 })]).toEqual([
      ["long", 0],
      ["short", 1],
      ["a", 0xe40c292c]
    ])
  })
})
