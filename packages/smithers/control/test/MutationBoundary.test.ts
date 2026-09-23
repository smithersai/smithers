/**
 * The inert boundary every control mutation crosses before its first wait.
 *
 * `admit` is the only thing between a caller's object and a durable
 * fingerprint. Its refusals are what stop a getter, a `toJSON`, a proxy, a
 * cycle, or a multi-megabyte payload from being evaluated inside a mutation's
 * transaction, and each refusal is a separate branch: the end-to-end mutation
 * suites reach the accepting path and almost none of the refusing ones.
 *
 * Every case here asserts the complaint, not just `ok: false`, because the
 * complaint is what an operator reads on `InvalidInput`.
 */
import { describe, expect, it } from "vitest"
import { admit } from "../src/internal/MutationBoundary.ts"

const refusal = (input: unknown): string => {
  const result = admit(input)
  if (result.ok) throw new Error("expected a refusal, got an admitted value")
  return result.complaint
}

const accepted = (input: unknown): unknown => {
  const result = admit(input)
  if (!result.ok) throw new Error(`expected admission, got ${result.complaint}`)
  return result.value
}

describe("MutationBoundary.admit accepts inert JSON", () => {
  it("copies every JSON scalar", () => {
    expect(accepted(null)).toBe(null)
    expect(accepted(true)).toBe(true)
    expect(accepted(false)).toBe(false)
    expect(accepted(0)).toBe(0)
    expect(accepted(-1.5)).toBe(-1.5)
    expect(accepted("")).toBe("")
    expect(accepted("plain")).toBe("plain")
  })

  it("copies arrays and objects into frozen, prototype-free values", () => {
    const value = accepted({ list: [1, "two", { three: null }], flag: true }) as Record<string, unknown>
    expect(value).toEqual({ list: [1, "two", { three: null }], flag: true })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.getPrototypeOf(value)).toBe(null)
    expect(Object.isFrozen(value["list"])).toBe(true)
  })

  it("detaches the copy from the caller's object", () => {
    const source: { nested: { value: number } } = { nested: { value: 1 } }
    const copy = accepted(source) as { readonly nested: { readonly value: number } }
    source.nested.value = 2
    expect(copy.nested.value).toBe(1)
  })

  it("drops a non-enumerable own property rather than refusing", () => {
    const source = {}
    Object.defineProperty(source, "hidden", { value: 1, enumerable: false })
    expect(accepted(source)).toEqual({})
  })

  it("accepts every escape class a JSON string can carry", () => {
    // The byte accounting has a branch per class: short escapes, control
    // characters, ASCII, two-byte, three-byte, and surrogate pairs.
    expect(accepted("\"\\\b\t\n\f\raé中\u{1f600}")).toBe(
      "\"\\\b\t\n\f\raé中\u{1f600}"
    )
  })

  it("accepts an object key needing escapes", () => {
    expect(accepted({ "a\nb": 1 })).toEqual({ "a\nb": 1 })
  })

  it("accepts an empty array and an empty object", () => {
    expect(accepted([])).toEqual([])
    expect(accepted({})).toEqual({})
  })

  it("accepts a null-prototype object", () => {
    const source = Object.create(null) as Record<string, unknown>
    source["a"] = 1
    expect(accepted(source)).toEqual({ a: 1 })
  })

  it("accepts a non-enumerable extra property on an array", () => {
    const source: Array<number> = [1, 2]
    Object.defineProperty(source, "extra", { value: "x", enumerable: false })
    expect(accepted(source)).toEqual([1, 2])
  })
})

describe("MutationBoundary.admit refuses what it cannot copy inertly", () => {
  it("refuses a value whose type has no JSON form", () => {
    expect(refusal(undefined)).toBe("contains a non-JSON undefined")
    expect(refusal(() => 1)).toBe("contains a non-JSON function")
    expect(refusal(Symbol("s"))).toBe("contains a non-JSON symbol")
    expect(refusal(1n)).toBe("contains a non-JSON bigint")
    expect(refusal({ nested: undefined })).toBe("contains a non-JSON undefined")
    expect(refusal([undefined])).toBe("contains a non-JSON undefined")
  })

  it("refuses a non-finite number", () => {
    expect(refusal(Number.NaN)).toBe("contains a non-finite number")
    expect(refusal(Number.POSITIVE_INFINITY)).toBe("contains a non-finite number")
    expect(refusal({ budget: Number.NEGATIVE_INFINITY })).toBe("contains a non-finite number")
  })

  it("refuses ill-formed text in a value and in a key", () => {
    expect(refusal("\ud800")).toBe("contains oversized or ill-formed text")
    expect(refusal("\ud800a")).toBe("contains oversized or ill-formed text")
    expect(refusal("\udc00")).toBe("contains oversized or ill-formed text")
    expect(refusal({ "\ud800": 1 })).toBe("contains an oversized or ill-formed object key")
  })

  it("refuses an accessor and an enumerable symbol key", () => {
    const withGetter = {}
    Object.defineProperty(withGetter, "leak", {
      enumerable: true,
      get: () => {
        throw new Error("the boundary must never call this")
      }
    })
    expect(refusal(withGetter)).toBe("contains an accessor")

    const symbolKeyed = { [Symbol.for("s")]: 1 }
    expect(refusal(symbolKeyed)).toBe("contains an enumerable symbol")
  })

  it("never consults toJSON", () => {
    // `toJSON` is caller code. It is an ordinary enumerable function property
    // here, so the refusal proves the boundary read the property rather than
    // calling it.
    expect(refusal({ toJSON: () => ({ safe: true }) })).toBe("contains a non-JSON function")
  })

  it("refuses a cycle in an object and in an array", () => {
    const object: Record<string, unknown> = {}
    object["self"] = object
    expect(refusal(object)).toBe("contains a cycle")

    const array: Array<unknown> = []
    array.push(array)
    expect(refusal(array)).toBe("contains a cycle")
  })

  it("accepts a value reached twice without a cycle", () => {
    const shared = { value: 1 }
    expect(accepted({ left: shared, right: shared })).toEqual({ left: { value: 1 }, right: { value: 1 } })
  })

  it("refuses a non-plain object", () => {
    expect(refusal(new Date(0))).toBe("contains a non-plain object")
    expect(refusal(new Map())).toBe("contains a non-plain object")
    expect(refusal(new (class Wrapper {})())).toBe("contains a non-plain object")
  })

  it("refuses a sparse array and an enumerable non-index array member", () => {
    // eslint-disable-next-line no-sparse-arrays -- a hole is exactly the input under test.
    expect(refusal([1, , 3])).toBe("contains a sparse or accessor array member")

    const tagged: Array<number> = [1]
    Object.defineProperty(tagged, "extra", { value: "x", enumerable: true })
    expect(refusal(tagged)).toBe("has an enumerable non-index array member")
  })

  it("refuses an array member behind an accessor", () => {
    const array: Array<unknown> = [1]
    Object.defineProperty(array, "0", {
      enumerable: true,
      configurable: true,
      get: () => 1
    })
    expect(refusal(array)).toBe("contains a sparse or accessor array member")
  })

  it("refuses an array whose length it cannot trust", () => {
    const lying = new Proxy([], {
      getOwnPropertyDescriptor: (target, key) =>
        key === "length"
          // `length` is non-configurable but writable, so a proxy may report a
          // different value for it and still satisfy the invariants.
          ? { value: "not-a-number", enumerable: false, configurable: false, writable: true }
          : Reflect.getOwnPropertyDescriptor(target, key)
    })
    expect(refusal(lying)).toBe("has an invalid array length")
  })

  it("refuses a proxy that throws instead of executing its trap into the copy", () => {
    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("trap")
      }
    })
    expect(refusal(hostile)).toBe("cannot be inspected without executing object code")
  })

  it("refuses a value nested deeper than the depth budget", () => {
    let deep: unknown = 1
    for (let level = 0; level < 130; level++) deep = { deep }
    expect(refusal(deep)).toBe("exceeds the maximum JSON depth of 128")

    let allowed: unknown = 1
    for (let level = 0; level < 120; level++) allowed = [allowed]
    expect(admit(allowed).ok).toBe(true)
  })

  it("refuses more values than the node budget", () => {
    // Empty children add a node each without adding a member, so the node
    // budget is the one that trips rather than the member budget.
    expect(refusal(Array.from({ length: 100_000 }, () => []))).toBe("contains more than 100000 JSON values")
  })

  it("refuses more members than the member budget", () => {
    const wide: Record<string, number> = {}
    for (let index = 0; index < 100_001; index++) wide[`k${index}`] = 1
    expect(refusal(wide)).toBe("contains more than 100000 JSON members")
  })

  it("refuses a payload past the byte budget", () => {
    const megabyte = "a".repeat(1024 * 1024)
    expect(refusal([megabyte, megabyte, megabyte, megabyte, megabyte])).toBe("exceeds the JSON byte limit")
    expect(refusal("b".repeat(5 * 1024 * 1024))).toBe("contains oversized or ill-formed text")
  })

  it("refuses the value that crosses the byte budget, whatever its type", () => {
    // The budget is checked at every value, not only at strings. Filling it to
    // the last byte and then appending one more value of each type is what
    // proves the scalar accounting is enforced rather than merely computed.
    // 18 bytes is the outer object's own overhead plus both keys. A 1 KiB
    // budget reaches the same boundary as the 4 MiB production one without
    // building six multi-megabyte values.
    const bounds = {
      maxBytes: 1024,
      maxStringBytes: 1024,
      maxKeyBytes: 1024,
      maxDepth: 128,
      maxNodes: 100_000,
      maxMembers: 100_000,
      maxTotalMembers: 100_000
    }
    const big = "a".repeat(1024 - 18)
    for (const tail of [null, true, 1, {}, [], "x"]) {
      const result = admit({ big, tail }, bounds)
      expect(result.ok ? "admitted" : result.complaint).toBe("exceeds the JSON byte limit")
    }
    // The budget is inclusive: `{"big":"…"}` filled to exactly 1024 bytes is admitted.
    expect(admit({ big: "a".repeat(1024 - 10) }, bounds).ok).toBe(true)
  })

  it("refuses an array with more members than the member budget", () => {
    expect(refusal(Array.from({ length: 100_001 }, () => 1))).toBe("contains more than 100000 JSON members")
  })

  it("refuses an enumerable numeric key too large to be an index", () => {
    const array: Array<number> = [1]
    Object.defineProperty(array, "99999999999999999999", { value: 2, enumerable: true, configurable: true })
    expect(refusal(array)).toBe("has an enumerable non-index array member")
  })

  it("refuses a wide object whose keys alone exceed the byte budget", () => {
    const key = "k".repeat(4096)
    const wide: Record<string, number> = {}
    for (let index = 0; index < 2000; index++) wide[`${key}${index}`] = 1
    expect(refusal(wide)).toBe("exceeds the JSON byte limit")
  })
})
