import { describe, expect, it } from "vitest"
import * as DigestIndex from "../src/internal/digestIndex.ts"

type Value = readonly [number | undefined, number | undefined]
const check = (tree: DigestIndex.Index | undefined, expected: ReadonlyMap<number, Value>): void => {
  expect(tree?.size ?? 0).toBe(expected.size)
  if (expected.size === 0) {
    expect(tree).toBeUndefined()
    return
  }
  const starts = [...expected.values()].flatMap(([start]) => start === undefined ? [] : [start])
  const ends = [...expected.values()].flatMap(([, end]) => end === undefined ? [] : [end])
  expect(tree?.first).toBe(Math.min(...expected.keys()))
  expect(tree?.min).toBe(starts.length === 0 ? undefined : Math.min(...starts))
  expect(tree?.max).toBe(ends.length === 0 ? undefined : Math.max(...ends))
  const visit = (node: DigestIndex.Index | undefined): ReadonlyArray<number> => {
    if (node === undefined) return []
    const left = visit(node.left)
    const right = visit(node.right)
    expect(left.every((ordinal) => ordinal < node.ordinal)).toBe(true)
    expect(right.every((ordinal) => ordinal > node.ordinal)).toBe(true)
    expect(Math.abs((node.left?.height ?? 0) - (node.right?.height ?? 0))).toBeLessThanOrEqual(1)
    expect(node.height).toBe(1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0))
    expect(node.bytes).toBeGreaterThan((node.left?.bytes ?? 0) + (node.right?.bytes ?? 0))
    return [...left, node.ordinal, ...right]
  }
  expect(visit(tree)).toEqual([...expected.keys()].sort((a, b) => a - b))
}

describe("diagnosis scalar indexes", () => {
  const ascending = Array.from({ length: 64 }, (_, ordinal) => ordinal)
  for (const order of [ascending, [...ascending].reverse(), ascending.map((value) => (value * 37) % 64)]) {
    it(`retains exact extrema through ordered inserts, replacements and removals starting ${order[0]}`, () => {
      let tree: DigestIndex.Index | undefined
      const expected = new Map<number, Value>()
      for (const ordinal of order) {
        const value = [ordinal % 7, ordinal % 11] as const
        tree = DigestIndex.set(tree, ordinal, ...value)
        expected.set(ordinal, value)
        check(tree, expected)
      }
      const before = tree
      const original = new Map(expected)
      for (const ordinal of order) {
        const value: Value = ordinal % 2 ? [undefined, undefined] : [1000 - ordinal, -ordinal]
        tree = DigestIndex.set(tree, ordinal, ...value)
        expected.set(ordinal, value)
        check(tree, expected)
      }
      check(before, original)
      tree = DigestIndex.remove(tree, -1)
      tree = DigestIndex.remove(tree, 999)
      check(tree, expected)
      for (
        const ordinal of ascending.filter((value) => value % 2 === 0).concat(ascending.filter((value) => value % 2))
      ) {
        tree = DigestIndex.remove(tree, ordinal)
        expected.delete(ordinal)
        check(tree, expected)
      }
      expect(DigestIndex.remove(tree, 1)).toBeUndefined()
      check(before, original)
    })
  }
})
