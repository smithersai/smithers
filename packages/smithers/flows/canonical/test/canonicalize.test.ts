import { describe, expect, it } from "vitest"
import { CanonicalError, canonicalize } from "../src/index.ts"

const rejects = (value: unknown, code: string, path: string, detail?: string): void => {
  try {
    canonicalize(value)
    throw new Error("expected canonicalize to throw")
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalError)
    expect(error).toMatchObject({ code, path })
    expect((error as Error).message).toContain(`${code}:`)
    expect((error as Error).message).toContain(`at ${path}`)
    if (detail !== undefined) expect((error as Error).message).toContain(detail)
  }
}

describe("canonicalize errors", () => {
  it.each([
    [Number.NaN, "canonical_nan", "$", "NaN"],
    [{ payload: { cost: Number.POSITIVE_INFINITY } }, "canonical_non_finite", "$.payload.cost", "Infinity"],
    [{ payload: { cost: Number.NEGATIVE_INFINITY } }, "canonical_non_finite", "$.payload.cost", "-Infinity"],
    [{ "exotic key": "\ud800" }, "canonical_lone_surrogate", "$[\"exotic key\"]", "value"],
    [{ "\ud800": 1 }, "canonical_lone_surrogate", "$[\"\\ud800\"]", "key"],
    [undefined, "canonical_unsupported_value", "$", "undefined"],
    [Symbol("x"), "canonical_unsupported_value", "$", "symbol"],
    [(): void => undefined, "canonical_unsupported_value", "$", "function"],
    [1n, "canonical_bigint", "$", "BigInt"]
  ])("reports %s with stable code and path", (value, code, path, detail) => {
    rejects(value, code, path, detail)
  })

  it("reports the path where a circular object is re-entered", () => {
    const value: Record<string, unknown> = {}
    value.loop = value
    rejects(value, "canonical_circular", "$.loop")
  })

  it("wraps toJSON and getter causes", () => {
    const toJSONCause = new Error("toJSON exploded")
    expect(() =>
      canonicalize({
        x: {
          toJSON: () => {
            throw toJSONCause
          }
        }
      })
    ).toThrow(
      expect.objectContaining({ code: "canonical_tojson_threw", path: "$.x", cause: toJSONCause })
    )
    const getterCause = new Error("getter exploded")
    expect(() =>
      canonicalize({
        get x(): never {
          throw getterCause
        }
      })
    ).toThrow(
      expect.objectContaining({ code: "canonical_getter_threw", path: "$.x", cause: getterCause })
    )
    const toJSONGetterCause = new Error("toJSON getter exploded")
    expect(() =>
      canonicalize({
        get toJSON(): never {
          throw toJSONGetterCause
        }
      })
    ).toThrow(
      expect.objectContaining({ code: "canonical_getter_threw", path: "$", cause: toJSONGetterCause })
    )
  })

  describe.each(
    [
      ["throwing toString", () => ({
        toString(): never {
          throw null
        }
      })],
      ["null prototype", () => Object.create(null) as object],
      ["throwing getPrototypeOf", () =>
        new Proxy({}, {
          getPrototypeOf(): never {
            throw new Error("prototype")
          }
        })],
      ["throwing message getter", () =>
        Object.defineProperty(new Error(), "message", {
          get(): never {
            throw new Error("message")
          }
        })]
    ] as const
  )("hostile thrown value: %s", (_name, makeCause) => {
    it.each(["toJSON", "getter", "proxy"] as const)("preserves the cause from %s", (source) => {
      const cause = makeCause()
      const fail = (): never => {
        throw cause
      }
      const input = source === "toJSON"
        ? { item: { toJSON: fail } }
        : source === "getter"
        ? {
          get item(): never {
            return fail()
          }
        }
        : { item: new Proxy({}, { ownKeys: fail }) }
      let thrown: unknown
      try {
        canonicalize(input)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(CanonicalError)
      const error = thrown as CanonicalError
      expect(error.code).toBe(source === "toJSON" ? "canonical_tojson_threw" : "canonical_getter_threw")
      expect(error.path).toBe("$.item")
      expect(error.cause).toBe(cause)
      expect(error.message).toBe(`${error.code}: Unable to describe thrown value at $.item`)
    })
  })

  it.each([new Error("x".repeat(2048)), "x".repeat(2048)])("bounds thrown-value details", (cause) => {
    expect(() =>
      canonicalize({
        toJSON(): never {
          throw cause
        }
      })
    ).toThrow(
      expect.objectContaining({ message: `canonical_tojson_threw: ${"x".repeat(1024)} at $` })
    )
  })

  it("wraps an exception raised while coercing an object tag", () => {
    const cause = new Error("tag exploded")
    const value = {
      get [Symbol.toStringTag](): never {
        throw cause
      }
    }
    expect(() => canonicalize(value)).toThrow(
      expect.objectContaining({ code: "canonical_getter_threw", path: "$", cause })
    )
  })
})

describe("JSON.stringify parity", () => {
  it("passes the exact key to toJSON", () => {
    const keys: Array<string> = []
    const make = () => ({
      toJSON(key: string) {
        keys.push(key)
        return key
      }
    })
    expect(canonicalize({ x: make(), array: [make()] })).toBe("{\"array\":[\"0\"],\"x\":\"x\"}")
    expect(keys).toEqual(["0", "x"])
    canonicalize(make())
    expect(keys.at(-1)).toBe("")
  })

  it.each([
    [new Number(1), "1"],
    [new String("ab"), "\"ab\""],
    [new Boolean(true), "true"]
  ])("unboxes %s", (value, expected) => expect(canonicalize(value)).toBe(expected))

  it("rejects boxed invalid numbers and BigInt", () => {
    rejects(new Number(Number.NaN), "canonical_nan", "$", "NaN")
    rejects(new Number(Number.POSITIVE_INFINITY), "canonical_non_finite", "$", "Infinity")
    rejects(Object(1n), "canonical_bigint", "$", "BigInt")
  })

  it.each([
    [[, 1], "[null,1]"],
    [[1, ,], "[1,null]"]
  ])("renders sparse arrays", (value, expected) => expect(canonicalize(value)).toBe(expected))
})

describe("digest-unsafe built-ins", () => {
  it.each([
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1])],
    ["WeakMap", new WeakMap()],
    ["WeakSet", new WeakSet()],
    ["ArrayBuffer", new ArrayBuffer(2)],
    ["Uint8Array", new Uint8Array([1])],
    ["RegExp", /x/],
    ["Error", new Error("x")],
    // An Error subclass is named by its concrete constructor, not the base
    // class: "TypeError at $.x" tells the caller which value leaked in.
    ["TypeError", new TypeError("x")],
    ["RangeError", new RangeError("x")]
  ])("rejects %s", (name, value) => rejects(value, "canonical_unsupported_value", "$", name))

  it("falls back to \"Error\" when the instance erased its constructor", () => {
    const erased = new Error("x")
    Object.defineProperty(erased, "constructor", { value: undefined })
    rejects(erased, "canonical_unsupported_value", "$", "Error")
  })

  it("wraps a proxy whose length trap throws as canonical_getter_threw", () => {
    const trapped = new Proxy([1], {
      get(target, key, receiver) {
        if (key === "length") throw new Error("len")
        return Reflect.get(target, key, receiver)
      }
    })
    rejects({ xs: trapped }, "canonical_getter_threw", "$.xs")
  })

  describe("proxy array length follows JSON.stringify ToLength", () => {
    const withLength = (length: unknown) =>
      new Proxy([10, 20, 30], {
        get(target, key, receiver) {
          return key === "length" ? length : Reflect.get(target, key, receiver)
        }
      })

    it.each([
      ["a fractional length", 2.5],
      ["a numeric string length", "2"],
      ["a NaN length", Number.NaN],
      ["a negative length", -1],
      ["a null length", null],
      ["an undefined length", undefined]
    ])("matches JSON.stringify for %s", (_name, length) => {
      const value = withLength(length)
      expect(canonicalize(value)).toBe(JSON.stringify(value))
    })

    it("reads the integer indices 0 and 1 for a fractional length", () => {
      expect(canonicalize(withLength(2.5))).toBe("[10,20]")
    })

    it("yields an empty array for a NaN length", () => {
      expect(canonicalize(withLength(Number.NaN))).toBe("[]")
    })

    it("wraps a length whose coercion throws as canonical_getter_threw", () => {
      const length = {
        valueOf() {
          throw new Error("len")
        }
      }
      expect(() => JSON.stringify(withLength(length))).toThrow("len")
      rejects({ xs: withLength(length) }, "canonical_getter_threw", "$.xs")
    })
  })

  it("keeps Date governed by toJSON", () => {
    expect(canonicalize(new Date(0))).toBe("\"1970-01-01T00:00:00.000Z\"")
  })
})

describe("observable object semantics", () => {
  it("snapshots keys then reads them in sorted order", () => {
    const reads: Array<string> = []
    const value: { a: number; b?: number } = {
      get b() {
        reads.push("b")
        return 2
      },
      get a() {
        reads.push("a")
        delete this.b
        return 1
      }
    }
    expect(canonicalize(value)).toBe("{\"a\":1}")
    expect(reads).toEqual(["a"])
  })

  it("serializes a proxy over a plain object through traps", () => {
    const seen: Array<string> = []
    const value = new Proxy({ b: 2, a: 1 }, {
      ownKeys(target) {
        seen.push("ownKeys")
        return Reflect.ownKeys(target)
      },
      get(target, key, receiver) {
        seen.push(String(key))
        return Reflect.get(target, key, receiver)
      }
    })
    expect(canonicalize(value)).toBe("{\"a\":1,\"b\":2}")
    expect(seen).toContain("ownKeys")
    expect(seen).toContain("a")
  })

  it("maps a throwing proxy trap", () => {
    const cause = new Error("trap exploded")
    const value = new Proxy({}, {
      ownKeys() {
        throw cause
      }
    })
    expect(() => canonicalize(value)).toThrow(
      expect.objectContaining({ code: "canonical_getter_threw", path: "$", cause })
    )
  })

  it("maps a throwing proxy prototype trap", () => {
    const cause = new Error("prototype trap exploded")
    const value = new Proxy({}, {
      getPrototypeOf() {
        throw cause
      }
    })
    expect(() => canonicalize(value)).toThrow(
      expect.objectContaining({ code: "canonical_getter_threw", path: "$", cause })
    )
  })

  it("rejects custom non-plain instances by constructor", () => {
    class DigestCollision {
      value = 1
    }
    rejects(new DigestCollision(), "canonical_unsupported_value", "$", "DigestCollision")
    rejects(Object.create(Object.create(null)), "canonical_unsupported_value", "$", "non-plain object")
  })

  it("maps a built-in classification getter failure", () => {
    const cause = new Error("constructor exploded")
    const value = new Uint8Array([1])
    Object.defineProperty(value, "constructor", {
      get(): never {
        throw cause
      }
    })
    expect(() => canonicalize(value)).toThrow(
      expect.objectContaining({ code: "canonical_getter_threw", path: "$", cause })
    )
  })
})

describe("documented divergences from JSON.stringify", () => {
  // Two corners where the docblock chooses digest determinism over byte-for-
  // byte stringify parity, pinned so the divergence stays deliberate.
  it("canonicalizes a chained toJSON result instead of stopping at one level", () => {
    // JSON.stringify serializes the first toJSON result as-is ("{}" here);
    // canonicalize keeps applying its own rules to the result.
    expect(canonicalize({ toJSON: (): unknown => ({ toJSON: (): number => 42 }) })).toBe("42")
  })

  it("unboxes wrappers from the internal slot, ignoring overridden coercers", () => {
    // JSON.stringify consults toString/valueOf overrides; canonicalize reads
    // the primitive the wrapper was constructed with, so a mutated wrapper
    // cannot change the digest of the value it boxes.
    const s = Object.assign(new String("ab"), { toString: (): string => "xy" })
    const n = Object.assign(new Number(1), { valueOf: (): number => 7 })
    expect(canonicalize({ s, n })).toBe("{\"n\":1,\"s\":\"ab\"}")
  })
})

describe("toJSON boundary sweep", () => {
  it("honors inherited toJSON", () => {
    const value = Object.create({
      toJSON(key: string) {
        return { key }
      }
    }) as object
    expect(canonicalize({ x: value })).toBe("{\"x\":{\"key\":\"x\"}}")
  })

  it.each([
    ["undefined", (): undefined => undefined, undefined, "[null]", "{}"],
    ["symbol", (): symbol => Symbol("x"), undefined, "[null]", "{}"],
    ["function", (): () => void => () => undefined, undefined, "[null]", "{}"]
  ])("handles a toJSON result of %s by position", (_name, toJSON, top, array, member) => {
    expect(() => canonicalize({ toJSON })).toThrow(expect.objectContaining({ code: "canonical_unsupported_value" }))
    expect(canonicalize([{ toJSON }])).toBe(array)
    expect(canonicalize({ x: { toJSON } })).toBe(member)
    expect(top).toBeUndefined()
  })

  it("locates invalid values inside a toJSON result", () => {
    rejects({ x: { toJSON: () => 1n } }, "canonical_bigint", "$.x.toJSON()")
    rejects({ x: { toJSON: () => "\ud800" } }, "canonical_lone_surrogate", "$.x.toJSON()")
    rejects({ x: { toJSON: () => Number.NaN } }, "canonical_nan", "$.x.toJSON()")
    rejects({ x: { toJSON: () => Number.NEGATIVE_INFINITY } }, "canonical_non_finite", "$.x.toJSON()", "-Infinity")
  })
})

describe("RFC 8785 vectors", () => {
  // RFC 8785 §3.2.2.3 and Appendix B number serialization samples.
  it.each([
    [0, "0"],
    [-0, "0"],
    [1e21, "1e+21"],
    [1e-7, "1e-7"],
    [333333333.33333329, "333333333.3333333"],
    [9007199254740992, "9007199254740992"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"]
  ])("serializes RFC number %s", (input, expected) => expect(canonicalize(input)).toBe(expected))

  // RFC 8785 §3.2.3: property names are sorted as UTF-16 code units.
  it("sorts empty, numeric-looking, and Unicode keys", () => {
    expect(canonicalize({ "2": 2, "10": 10, "": 0, "€": 3, "😀": 4 })).toBe(
      "{\"\":0,\"10\":10,\"2\":2,\"€\":3,\"😀\":4}"
    )
  })

  // RFC 8785 §3.2.2 canonical example document.
  it("matches the canonical example", () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
      string: "€$\u000f\nA'B\"\\\"/",
      literals: [null, true, false]
    }
    expect(canonicalize(input)).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}"
    )
  })
})

describe("depth", () => {
  it("serializes through 10,000 levels and rejects the next level deterministically", () => {
    let within: unknown = null
    for (let index = 0; index < 10_000; index++) within = [within]
    expect(canonicalize(within)).toBe("[".repeat(10_000) + "null" + "]".repeat(10_000))

    let beyond: unknown = null
    for (let index = 0; index < 10_001; index++) beyond = [beyond]
    try {
      canonicalize(beyond)
      throw new Error("expected depth rejection")
    } catch (error) {
      expect(error).toMatchObject({ code: "canonical_depth_exceeded" })
      expect((error as Error).message).toContain("10,001")
      expect((error as { path: string }).path.startsWith("$[0][0]")).toBe(true)
    }
  })
})
