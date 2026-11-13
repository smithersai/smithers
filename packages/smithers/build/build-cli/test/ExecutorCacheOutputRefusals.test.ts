/**
 * The cache output envelope stores only values JSON replays unchanged, and a
 * cached envelope is revalidated without trusting its object shape. Each case
 * below is a value or envelope the cache must refuse with a named reason.
 */
import { describe, expect, it } from "vitest"
import { entryLimit } from "../src/Cache.ts"
import { decodeCacheOutput, encodeCacheOutput } from "../src/Executor.ts"

/** The reason an encoding was refused; fails the test when it was accepted. */
const refusal = (value: unknown): string => {
  const encoded = encodeCacheOutput(value)
  if (!("reason" in encoded)) throw new Error(`expected a refusal, encoded ${JSON.stringify(encoded.output)}`)
  return encoded.reason
}

/** A real envelope, so the decode cases differ from it in one property only. */
const envelope = (): Record<string, unknown> => {
  const encoded = encodeCacheOutput({ passed: true })
  if (!("output" in encoded)) throw new Error(encoded.reason)
  return encoded.output as Record<string, unknown>
}

describe("encodeCacheOutput", () => {
  it("round trips false members", () => {
    const encoded = encodeCacheOutput({ cached: false, flags: [false, true] })
    if (!("output" in encoded)) throw new Error(encoded.reason)
    expect(decodeCacheOutput(encoded.output)).toEqual({ value: { cached: false, flags: [false, true] } })
  })

  it("refuses a value larger than one cache entry", () => {
    expect(refusal("x".repeat(entryLimit))).toBe(`result exceeds the ${entryLimit}-byte cache output limit`)
  })

  it("refuses an array subclass instance", () => {
    class Paths extends Array<string> {}
    expect(refusal(Paths.from(["a.ts"]))).toBe("result is an array subclass instance")
  })

  it("refuses an accessor element without invoking it", () => {
    let reads = 0
    const items: Array<unknown> = ["a.ts"]
    Object.defineProperty(items, "0", {
      enumerable: true,
      get: () => {
        reads += 1
        return "b.ts"
      }
    })
    expect(refusal({ items })).toBe("result.items[0] is an accessor or non-enumerable property")
    expect(reads).toBe(0)
  })

  it("refuses a non-enumerable element that JSON would drop from a spread", () => {
    const items: Array<unknown> = ["a.ts", "b.ts"]
    Object.defineProperty(items, "1", { enumerable: false })
    expect(refusal(items)).toBe("result[1] is an accessor or non-enumerable property")
  })
})

describe("decodeCacheOutput", () => {
  it("refuses an envelope without the plain object prototype", () => {
    const nullPrototype = Object.assign(Object.create(null) as object, envelope())
    expect(decodeCacheOutput(nullPrototype)).toEqual({ reason: "cached output is not a plain envelope" })
  })

  it("refuses an envelope carrying a symbol-keyed property", () => {
    const tagged = { ...envelope(), [Symbol("extra")]: 1 }
    expect(decodeCacheOutput(tagged)).toEqual({ reason: "cached output is not a plain envelope" })
  })

  it("refuses an envelope without a data tag", () => {
    expect(decodeCacheOutput({ value: { passed: true } })).toEqual({ reason: "cached output has no data tag" })
  })

  it("refuses an envelope whose value is an accessor, without invoking it", () => {
    let reads = 0
    const { _tag } = envelope()
    const accessor = Object.defineProperty({ _tag }, "value", {
      enumerable: true,
      get: () => {
        reads += 1
        return { passed: true }
      }
    })
    expect(decodeCacheOutput(accessor)).toEqual({ reason: "cached output value is not a data property" })
    expect(reads).toBe(0)
  })

  it("decodes the untouched envelope", () => {
    expect(decodeCacheOutput(envelope())).toEqual({ value: { passed: true } })
  })
})
