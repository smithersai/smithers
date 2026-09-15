import { describe, expect, it, vi } from "vitest"
import * as ReadonlyMap from "../src/ReadonlyMap.ts"

describe("the immutable map facade", () => {
  it("supports every read operation without exposing mutation", () => {
    const map = ReadonlyMap.make<string, number>([["a", 1], ["b", 2]])
    const visited: Array<readonly [string, number]> = []
    const receiver = { marker: true }
    const callback = vi.fn(function(this: typeof receiver, value: number, key: string) {
      expect(this).toBe(receiver)
      visited.push([key, value])
    })

    map.forEach(callback, receiver)

    expect(map.size).toBe(2)
    expect(map.has("a")).toBe(true)
    expect(map.has("missing")).toBe(false)
    expect(map.get("b")).toBe(2)
    expect([...map.entries()]).toEqual([["a", 1], ["b", 2]])
    expect([...map.keys()]).toEqual(["a", "b"])
    expect([...map.values()]).toEqual([1, 2])
    expect([...map]).toEqual([["a", 1], ["b", 2]])
    expect(visited).toEqual([["a", 1], ["b", 2]])
    expect(Object.isFrozen(map)).toBe(true)
    expect((map as unknown as { set?: unknown }).set).toBeUndefined()
  })
})
