import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import { Canonical } from "../src/index.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const decode = Schema.decodeUnknownEffect(Canonical)

const attempt = (value: unknown): Result.Result<string, Schema.SchemaError> =>
  Effect.runSync(Effect.result(decode(value)))

const serialize = (value: unknown): string => Effect.runSync(decode(value))

const parse = (document: string): unknown => Schema.encodeUnknownSync(Canonical)(document)

/**
 * Mirrors the well-formedness scan only as a generator precondition — every
 * assertion below is against the schema, never against this helper.
 */
const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

const codeUnitCompare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

describe("Canonical properties", () => {
  it("matches JSON.stringify after parsing for stringify-safe generated values", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.jsonValue(), (value) => {
        const document = serialize(value)
        expect(JSON.parse(document)).toEqual(JSON.parse(JSON.stringify(value)))
        expect(() => JSON.parse(document)).not.toThrow()
      }),
      params
    )
  })

  it("canonicalization is idempotent and total over hostile JSON values", () => {
    // c(parse(c(x))) === c(x): a canonical document re-enters the serializer
    // and comes out byte-identical, so digests taken over documents are stable
    // across hosts that re-serialize. Values with no canonical form (lone
    // surrogates from the binary string unit) must fail with a typed
    // SchemaError, never a throw.
    FastCheck.assert(
      FastCheck.property(FastCheck.jsonValue({ stringUnit: "binary" }), (value) => {
        const first = attempt(value)
        if (Result.isFailure(first)) {
          expect(first.failure._tag).toBe("SchemaError")
          return
        }
        const document = first.success
        // The document is valid JSON text...
        JSON.parse(document)
        // ...and canonicalizing its parse yields the same bytes.
        expect(serialize(parse(document))).toBe(document)
      }),
      { ...params, examples: [[{ "\ud800": -0 }], [-0], [1e21], [""], [[]], [{}]] }
    )
  })

  it("object keys emerge in UTF-16 code-unit order regardless of insertion order", () => {
    const wellFormedKey = FastCheck.string({ unit: "binary" }).filter((value) => !hasLoneSurrogate(value))
    const entriesArbitrary = FastCheck.uniqueArray(
      FastCheck.tuple(wellFormedKey, FastCheck.integer()),
      { selector: (entry) => entry[0] }
    )
    FastCheck.assert(
      FastCheck.property(entriesArbitrary, (generated) => {
        // Object.fromEntries creates own data properties, so hostile keys like
        // "__proto__" stay ordinary members rather than touching the prototype.
        const document = serialize(Object.fromEntries(generated))
        const reversed = serialize(Object.fromEntries([...generated].reverse()))
        const descending = serialize(
          Object.fromEntries([...generated].sort((a, b) => codeUnitCompare(b[0], a[0])))
        )
        expect(reversed).toBe(document)
        expect(descending).toBe(document)

        // Differential oracle: members appear sorted by UTF-16 code unit, with
        // JSON.stringify escaping — exactly RFC 8785's member ordering.
        const expected = `{${
          [...generated]
            .sort((a, b) => codeUnitCompare(a[0], b[0]))
            .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
            .join(",")
        }}`
        expect(document).toBe(expected)
      }),
      {
        ...params,
        examples: [
          [[["__proto__", 1], ["constructor", 2], ["", 3]]],
          [[["10", 1], ["2", 2], ["A", 3], ["a", 4]]],
          [[["", 1], ["😀", 2], ["a", 3]]]
        ]
      }
    )
  })

  it("serializes every finite double as its shortest ECMAScript form and refuses the rest", () => {
    // RFC 8785 defers number serialization to ECMA-262 `JSON.stringify`, and
    // the parse of that shortest form recovers the exact double — except -0,
    // whose sign the format erases by contract. Non-finite numbers have no
    // canonical form and must fail as typed schema errors.
    FastCheck.assert(
      FastCheck.property(FastCheck.double({ noNaN: false }), (value) => {
        const outcome = attempt(value)
        if (!Number.isFinite(value)) {
          expect(Result.isFailure(outcome)).toBe(true)
          if (Result.isFailure(outcome)) {
            expect(outcome.failure._tag).toBe("SchemaError")
            expect(outcome.failure.message).toMatch(/canonical_nan: NaN|canonical_non_finite: [+-]?Infinity/)
          }
          return
        }
        expect(Result.isSuccess(outcome)).toBe(true)
        if (Result.isSuccess(outcome)) {
          expect(outcome.success).toBe(JSON.stringify(value))
          expect(JSON.parse(outcome.success)).toBe(Object.is(value, -0) ? 0 : value)
        }
      }),
      {
        ...params,
        examples: [
          [-0],
          [1e21],
          [1e-7],
          [1e-6],
          [1e20],
          [5e-324],
          [Number.MAX_VALUE],
          [Number.MAX_SAFE_INTEGER],
          [Number.MIN_SAFE_INTEGER],
          [9007199254740994],
          [Number.NaN],
          [Number.POSITIVE_INFINITY],
          [Number.NEGATIVE_INFINITY]
        ]
      }
    )
  })

  it("refuses a lone surrogate anywhere on the direct value path", () => {
    // The example suite pins the toJSON bypass; this generalizes the DIRECT
    // path: any string carrying a lone surrogate — as a value, a key, or
    // nested — has no canonical form and fails with a typed SchemaError.
    const loneSurrogateString = FastCheck.tuple(
      FastCheck.string({ unit: "binary" }),
      FastCheck.integer({ min: 0xd800, max: 0xdfff }),
      FastCheck.string({ unit: "binary" })
    )
      .map(([prefix, code, suffix]) => `${prefix}${String.fromCharCode(code)}${suffix}`)
      .filter(hasLoneSurrogate)
    FastCheck.assert(
      FastCheck.property(
        loneSurrogateString,
        FastCheck.constantFrom("value", "key", "nested"),
        (text, position) => {
          const value = position === "value"
            ? text
            : position === "key"
            ? { [text]: 1 }
            : [{ nested: text }]
          const outcome = attempt(value)
          expect(Result.isFailure(outcome)).toBe(true)
          if (Result.isFailure(outcome)) {
            expect(outcome.failure._tag).toBe("SchemaError")
            expect(outcome.failure.message).toContain("canonical_lone_surrogate:")
          }
        }
      ),
      { ...params, examples: [["\ud800", "value"], ["\udfff", "key"], ["a\ud800b", "nested"]] }
    )
  })
})
