import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { canonicalize, sortCollections } from "../src/index.ts"

/** Evaluates `source` in a new realm, with its own `Set`, `Map` and `Object`. */
const foreign = <A>(source: string): A => runInNewContext(`(${source})`) as A

/** A value's collections as tagged arrays in iteration order, so it can be compared and hashed. */
const snapshot = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value
  const entries: Array<unknown> = []
  try {
    Set.prototype.forEach.call(value, (entry) => entries.push(snapshot(entry)))
    return ["Set", ...entries]
  } catch {
    // Not a set.
  }
  try {
    Map.prototype.forEach.call(value, (entry, key) => entries.push([snapshot(key), snapshot(entry)]))
    return ["Map", ...entries]
  } catch {
    // Not a map.
  }
  if (Array.isArray(value)) return value.map(snapshot)
  if (Object.prototype.toString.call(value) === "[object Date]") return ["Date", Date.prototype.getTime.call(value)]
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)]))
}

const identity = (value: unknown): string => canonicalize(snapshot(sortCollections(value)))

describe("collections from another realm (#R2-Astra-D1-015)", () => {
  it("sorts a foreign set exactly as a local one", () => {
    expect([...sortCollections(new Set([2, 1]))]).toEqual([1, 2])
    const sorted = sortCollections(foreign<Set<number>>("new Set([2, 1])"))
    expect(snapshot(sorted)).toEqual(["Set", 1, 2])
  })

  it("gives equal sets and maps one snapshot across realms and insertion orders", () => {
    const local = { tags: new Set(["b", "a", "c"]), limits: new Map([["y", 2], ["x", 1]]) }
    const other = foreign("{ tags: new Set(['c', 'a', 'b']), limits: new Map([['x', 1], ['y', 2]]) }")
    const reversed = foreign("{ tags: new Set(['a', 'b', 'c']), limits: new Map([['y', 2], ['x', 1]]) }")
    const expected = "{\"limits\":[\"Map\",[\"x\",1],[\"y\",2]],\"tags\":[\"Set\",\"a\",\"b\",\"c\"]}"
    expect(identity(local)).toBe(expected)
    expect(identity(other)).toBe(expected)
    expect(identity(reversed)).toBe(expected)
  })

  it("sorts nested foreign collections at every depth", () => {
    const one = foreign(
      "{ a: [new Map([[new Set([2, 1]), new Set(['y', 'x'])], [new Set([0]), new Set([new Set([4, 3])])]])] }"
    )
    const two = foreign(
      "{ a: [new Map([[new Set([0]), new Set([new Set([3, 4])])], [new Set([1, 2]), new Set(['x', 'y'])]])] }"
    )
    expect(identity(one)).toBe(identity(two))
    expect(identity(one)).toBe(
      "{\"a\":[[\"Map\",[[\"Set\",0],[\"Set\",[\"Set\",3,4]]],[[\"Set\",1,2],[\"Set\",\"x\",\"y\"]]]]}"
    )
  })

  it("sorts a local set whose entries came from another realm", () => {
    const entries = foreign<ReadonlyArray<object>>("[new Set([2, 1]), new Set([1, 0])]")
    const expected = "[\"Set\",[\"Set\",0,1],[\"Set\",1,2]]"
    expect(identity(new Set(entries))).toBe(expected)
    expect(identity(new Set([...entries].reverse()))).toBe(expected)
  })

  it("ranks foreign dates, wrappers, patterns and buffers by their value, not their insertion order", () => {
    const ranked = (source: string): string => identity(foreign(source))
    expect(ranked("new Set([new Date(2), new Date(1)])")).toBe(ranked("new Set([new Date(1), new Date(2)])"))
    expect(ranked("new Set([new Date(2), new Date(1)])")).toBe("[\"Set\",[\"Date\",1],[\"Date\",2]]")
    const order = (source: string): ReadonlyArray<string> => {
      const out: Array<string> = []
      Set.prototype.forEach.call(sortCollections(foreign<object>(source)), (entry) => {
        out.push(
          ArrayBuffer.isView(entry) || Object.prototype.toString.call(entry) === "[object ArrayBuffer]"
            ? String(new Uint8Array(entry as ArrayBuffer)[0])
            : String(entry)
        )
      })
      return out
    }
    expect(order("new Set([new Number(2), new Number(1)])")).toEqual(["1", "2"])
    expect(order("new Set([new String('b'), new String('a')])")).toEqual(["a", "b"])
    expect(order("new Set([new Boolean(true), new Boolean(false)])")).toEqual(["false", "true"])
    expect(order("new Set([Object(2n), Object(1n)])")).toEqual(["1", "2"])
    expect(order("new Set([/b/g, /a/g])")).toEqual(["/a/g", "/b/g"])
    expect(order("new Set([new Uint8Array([2]).buffer, new Uint8Array([1]).buffer])")).toEqual(["1", "2"])
  })

  it("keeps a foreign collection's own prototype on its sorted copy", () => {
    const source = foreign<Set<number>>("new Set([2, 1])")
    const sorted = sortCollections(source)
    expect(sorted === source).toBe(false)
    expect(Object.getPrototypeOf(sorted) === Object.getPrototypeOf(source)).toBe(true)
    expect(sorted instanceof Set).toBe(false)
    expect([...sorted]).toEqual([1, 2])
    const map = sortCollections(foreign<Map<string, number>>("new Map([['b', 2], ['a', 1]])"))
    expect(Object.getPrototypeOf(map) === Map.prototype).toBe(false)
    expect([...map.keys()]).toEqual(["a", "b"])
  })

  it("reads and fills a subclass through the intrinsics, never through its overrides", () => {
    let calls = 0
    class Loud<A> extends Set<A> {
      override add(value: A): this {
        calls += 1
        return super.add(value)
      }
      override *[Symbol.iterator](): SetIterator<A> {
        calls += 1
        yield* super[Symbol.iterator]()
      }
    }
    class LoudMap<K, V> extends Map<K, V> {
      override set(key: K, value: V): this {
        calls += 1
        return super.set(key, value)
      }
    }
    const set = new Loud(["b", "a"])
    const map = new LoudMap([["b", 2], ["a", 1]])
    calls = 0
    const sorted = sortCollections({ set, map })
    expect(calls).toBe(0)
    expect(sorted.set).toBeInstanceOf(Loud)
    expect(snapshot(sorted)).toEqual({ set: ["Set", "a", "b"], map: ["Map", ["a", 1], ["b", 2]] })
  })
})
