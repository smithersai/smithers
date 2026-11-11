import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import { Canonical, CanonicalError, canonicalize, sortCollections } from "../src/index.ts"

const params = { numRuns: 100 }

const failure = (value: unknown): CanonicalError => {
  try {
    canonicalize(value)
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalError)
    return error as CanonicalError
  }
  throw new Error("Expected canonicalization to fail")
}

describe("boxed collection entries", () => {
  it.each([
    ["Number", new Number(1), new Number(2)],
    ["String", new String("a"), new String("b")],
    ["Boolean", new Boolean(false), new Boolean(true)],
    ["BigInt", Object(1n), Object(2n)]
  ])("ranks %s wrappers by their primitive slot", (_name, one, two) => {
    const forward = [...sortCollections(new Set([one, two]))]
    const reverse = [...sortCollections(new Set([two, one]))]
    expect(forward[0] === reverse[0]).toBe(true)
    expect(forward[1] === reverse[1]).toBe(true)
    expect(forward[0] === one).toBe(true)
  })

  it("gives equal boxed sets the same identity with a pass-through element schema", () => {
    const codec = Schema.Array(Schema.Unknown)
    const identity = (entries: ReadonlyArray<unknown>): string =>
      canonicalize(Schema.encodeSync(codec)([...sortCollections(new Set(entries))]))
    const one = Object.assign(new Number(1), { valueOf: () => 9 })
    const two = new Number(2)
    expect(identity([one, two])).toBe("[1,2]")
    expect(identity([two, one])).toBe("[1,2]")
  })

  it("orders boxed numbers and booleans independently of insertion and overridden coercers", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(FastCheck.oneof(FastCheck.integer(), FastCheck.boolean()), { maxLength: 20 }),
        (values) => {
          const boxed = values.map((value) =>
            Object.assign(Object(value), {
              valueOf() {
                throw new Error("must use the primitive slot")
              }
            })
          )
          const encode = (entries: ReadonlyArray<unknown>): string =>
            canonicalize([...sortCollections(new Set(entries))])
          expect(encode(boxed)).toBe(encode([...boxed].reverse()))
        }
      ),
      params
    )
  })

  it("orders boxed BigInt map keys by their slot even though JSON refuses them", () => {
    const one = Object(1n)
    const two = Object(2n)
    const input = new Map([[two, "two"], [one, "one"]])
    const output = [...sortCollections(input)]
    expect(output[0]![0] === one).toBe(true)
    expect(output[1]![0] === two).toBe(true)
    expect(failure(output).code).toBe("canonical_bigint")
  })

  it.each(
    [
      ["Number", () => new Number(1)],
      ["String", () => new String("slot")],
      ["Boolean", () => new Boolean(true)],
      ["BigInt", () => Object(1n)]
    ] as const
  )("keeps %s wrappers' own data in their rank", (_name, make) => {
    const toJSON = function(this: { readonly id: string }): string {
      return this.id
    }
    const a = Object.assign(make(), { id: "a", toJSON })
    const b = Object.assign(make(), { id: "b", toJSON })
    const identity = (entries: ReadonlyArray<unknown>): string => canonicalize([...sortCollections(new Set(entries))])
    expect(identity([a, b])).toBe("[\"a\",\"b\"]")
    expect(identity([b, a])).toBe("[\"a\",\"b\"]")
  })

  it.each(
    [
      ["wrapper prototype", () => Object.create(Number.prototype) as object],
      ["wrapper proxy", () => new Proxy(new Number(1), {})]
    ] as const
  )("ranks the own fields of a slotless %s", (_name, make) => {
    const a = Object.assign(make(), { id: "a" })
    const b = Object.assign(make(), { id: "b" })
    const sorted = [...sortCollections(new Set([b, a]))]
    expect(sorted[0] === a).toBe(true)
    expect(sorted[1] === b).toBe(true)
  })

  it("preserves a resource error raised while checking wrapper prototypes", () => {
    const cause = new RangeError("prototype resource limit")
    let ranked = false
    const value = new Proxy({}, {
      getPrototypeOf(target) {
        if (ranked) throw cause
        return Reflect.getPrototypeOf(target)
      }
    })
    const marker = new Proxy({}, {
      ownKeys(target) {
        ranked = true
        return Reflect.ownKeys(target)
      }
    })
    // The collection walk visits value first, then marker; ranking starts
    // after marker exposes the failure on value's next prototype inspection.
    expect(() => sortCollections(new Set([marker, value]))).toThrow(cause)
  })

  it("keeps uninspectable objects before symbols and null", () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const symbol = Symbol("q")
    const output = [...sortCollections(new Set<unknown>([null, symbol, revoked.proxy]))]
    expect(output[0] === revoked.proxy).toBe(true)
    expect(output[1]).toBe(symbol)
    expect(output[2]).toBe(null)
  })
})

describe("located bounded serialization failures", () => {
  it.each([2 ** 32, 2 ** 32 + 0.5, 2 ** 53, Infinity])(
    "refuses an array length above the allocation range: %s",
    (length) => {
      const reads: Array<PropertyKey> = []
      const array = new Proxy([], {
        get(target, key, receiver) {
          reads.push(key)
          return key === "length" ? length : Reflect.get(target, key, receiver)
        }
      })
      const error = failure({ xs: array })
      expect(error).toMatchObject({ code: "canonical_unsupported_value", path: "$.xs" })
      expect(error.message).toContain("array length")
      expect(reads).not.toContain("0")
      const schemaError = Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(Canonical)({ xs: array })))
      expect(schemaError.message).toContain("canonical_unsupported_value")
    }
  )

  it.each([
    undefined,
    null,
    42,
    Symbol("name"),
    {
      toString() {
        throw new Error("must not coerce the name")
      }
    },
    ""
  ])("ignores a non-text or empty constructor name (case %#)", (name) => {
    class Value {}
    Object.defineProperty(Value, "name", { value: name })
    const error = failure({ x: new Value() })
    expect(error).toMatchObject({ code: "canonical_unsupported_value", path: "$.x" })
    expect(error.message).toBe("canonical_unsupported_value: non-plain object at $.x")
  })

  it.each([
    () => new (class Value {})(),
    () => new Error("unused"),
    () => new Uint8Array([1])
  ])("bounds constructor names on rejected instances", (make) => {
    const value = make()
    Object.defineProperty(value, "constructor", { value: { name: "S".repeat(5000) } })
    if (!(value instanceof Error) && !ArrayBuffer.isView(value)) {
      Object.defineProperty(Object.getPrototypeOf(value), "constructor", { value: { name: "S".repeat(5000) } })
    }
    expect(failure({ x: value }).message).toBe(`canonical_unsupported_value: ${"S".repeat(1024)} at $.x`)
  })

  it.each([() => new Error(), () => new Uint8Array()])(
    "does not coerce hostile built-in constructor names",
    (make) => {
      const value = make()
      Object.defineProperty(value, "constructor", {
        value: {
          name: {
            toString() {
              throw new Error("raw boom")
            }
          }
        }
      })
      const error = failure(value)
      expect(error.code).toBe("canonical_unsupported_value")
      expect(error.message.length).toBeLessThan(100)
    }
  )
})

describe("built-in brands survive changed prototypes", () => {
  it("accepts plain records with a caller-defined Error string tag", () => {
    expect(canonicalize({ x: 1, [Symbol.toStringTag]: "Error" })).toBe("{\"x\":1}")
  })

  it("uses a fixed label for a typed array whose constructor is absent", () => {
    const value = new Uint8Array()
    Object.defineProperty(value, "constructor", { value: undefined })
    expect(failure(value).message).toBe("canonical_unsupported_value: typed array at $")
  })

  it.each(
    [
      ["Map", () => new Map([["a", 1]])],
      ["Set", () => new Set([1])],
      ["Uint8Array", () => new Uint8Array([1])]
    ] as const
  )("refuses a %s with a plain or null prototype", (name, make) => {
    for (const prototype of [null, Object.prototype]) {
      const value = Object.setPrototypeOf(make(), prototype)
      const error = failure({ x: value })
      expect(error).toMatchObject({ code: "canonical_unsupported_value", path: "$.x" })
      if (name === "Map" || name === "Set") expect(error.message).toContain(name)
    }
  })

  it.each(
    [
      ["Map", () => new Map([["x", 1]])],
      ["Set", () => new Set([1])]
    ] as const
  )("does not cache a %s as plain data after stack pressure", (_name, make) => {
    // Vary frame sizes as well as unwinding from the real engine limit.
    // Different call frames expose different remaining stack budgets without
    // replacing native brand operations or pinning an engine-specific depth.
    for (let size = 0; size < 32; size++) {
      const value = Object.setPrototypeOf(make(), null)
      const nearLimit = (...padding: Array<unknown>): string => {
        try {
          return nearLimit(...padding)
        } catch {
          try {
            canonicalize(value)
            return "serialized"
          } catch (error) {
            if (error instanceof CanonicalError && error.code === "canonical_unsupported_value") return error.code
            throw error
          }
        }
      }
      expect(nearLimit(...Array.from({ length: size }))).toBe("canonical_unsupported_value")
      expect(failure(value).code).toBe("canonical_unsupported_value")
    }
  })

  it("refuses generated Map and Set contents regardless of prototype and toStringTag", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(FastCheck.tuple(FastCheck.string(), FastCheck.integer()), { maxLength: 20 }),
        FastCheck.boolean(),
        FastCheck.boolean(),
        (entries, map, nullPrototype) => {
          const value = map ? new Map(entries) : new Set(entries.map(([, value]) => value))
          Object.defineProperty(value, Symbol.toStringTag, { value: "Object" })
          Object.setPrototypeOf(value, nullPrototype ? null : Object.prototype)
          const error = failure({ payload: value })
          expect(error).toMatchObject({ code: "canonical_unsupported_value", path: "$.payload" })
          expect(error.message).toContain(map ? "Map" : "Set")
        }
      ),
      params
    )
  })
})
