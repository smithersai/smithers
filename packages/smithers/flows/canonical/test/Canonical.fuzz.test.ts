import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BoundedJson, Canonical, CanonicalError, canonicalize, isRecord, sortCollections } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "2000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const runProp = <A>(arb: Arbitrary.Arbitrary<A>, prop: (a: A) => boolean, count = executions) =>
  Effect.runPromise(
    Fuzz.run(arb, prop, { seed, executions: count }).pipe(
      Effect.map((report) => {
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      })
    )
  )

// Strip lone surrogates from arbitrary strings so valid-JSON tests stay RFC 8785 legal.
const cleanString = (s: string): string => s.replace(/[\uD800-\uDFFF]/g, "_")

const JsonLeaf = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Finite,
  Schema.String
])

const JsonEntry = Schema.Tuple([Schema.String, JsonLeaf])

const shuffleKeys = (obj: Record<string, unknown>, perm: number): Record<string, unknown> => {
  const entries = Object.entries(obj)
  if (entries.length <= 1) return { ...obj }
  const rotated = [...entries.slice(perm % entries.length), ...entries.slice(0, perm % entries.length)].reverse()
  return Object.fromEntries(rotated)
}

describe("@smthrs/canonical fuzz invariants", () => {
  it("RFC 8785 canonicalize is deterministic, idempotent, key-order invariant, and UTF-16 sorted", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        entries: Schema.Array(JsonEntry),
        nested: Schema.Array(JsonEntry),
        perm: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))
      })
    )
    await runProp(arb, ({ entries, nested, perm }) => {
      const sanitizeLeaf = (v: null | boolean | number | string) =>
        typeof v === "string" ? cleanString(v) : Object.is(v, -0) ? 0 : v
      const inner: Record<string, unknown> = Object.create(null)
      for (const [k, v] of nested.slice(0, 8)) inner[cleanString(k)] = sanitizeLeaf(v)
      const outer: Record<string, unknown> = Object.create(null)
      for (const [k, v] of entries.slice(0, 10)) outer[cleanString(k)] = sanitizeLeaf(v)
      outer["__nested"] = inner

      const permuted = shuffleKeys({ ...outer, __nested: shuffleKeys(inner, perm) }, perm)
      const c1 = canonicalize(outer)
      const c2 = canonicalize(permuted)
      if (c1 !== c2) return false

      // Idempotency via JSON.parse round-trip and Schema decode.
      const parsed = JSON.parse(c1)
      if (canonicalize(parsed) !== c1) return false
      if (Schema.decodeUnknownSync(Canonical)(permuted) !== c1) return false

      // Compare emitted key positions in c1 against UTF-16 sorted key order (JS Object.keys hoists integer indices).
      const expectedKeys = Object.keys(parsed).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      const expectedRendered = "{" + expectedKeys.map((k) =>
        `${JSON.stringify(k)}:${canonicalize(parsed[k])}`
      ).join(",") + "}"
      if (c1 !== expectedRendered) return false
      return true
    })
  })

  it("rejects lone surrogates, non-finite numbers, BigInt, and non-plain objects with typed CanonicalError", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prefix: Schema.String,
        suffix: Schema.String,
        codeUnit: Schema.Int.check(Schema.isBetween({ minimum: 0xd800, maximum: 0xdfff })),
        kind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))
      })
    )
    await runProp(arb, ({ prefix, suffix, codeUnit, kind }) => {
      let value: unknown
      let expectedCode: string
      switch (kind) {
        case 0:
          value = `${cleanString(prefix)}${String.fromCharCode(codeUnit)}${cleanString(suffix)}`
          expectedCode = "canonical_lone_surrogate"
          break
        case 1:
          value = Number.NaN
          expectedCode = "canonical_nan"
          break
        case 2:
          value = Number.POSITIVE_INFINITY
          expectedCode = "canonical_non_finite"
          break
        case 3:
          value = BigInt(codeUnit)
          expectedCode = "canonical_bigint"
          break
        case 4:
          value = new Map([["a", 1]])
          expectedCode = "canonical_unsupported_value"
          break
        case 5:
          value = new Set([1, 2])
          expectedCode = "canonical_unsupported_value"
          break
        default: {
          const cyc: Record<string, unknown> = {}
          cyc.self = cyc
          value = cyc
          expectedCode = "canonical_circular"
        }
      }
      try {
        canonicalize(value)
        return false
      } catch (err) {
        return err instanceof CanonicalError && err.code === expectedCode
      }
    })
  })

  it("BoundedJson.admit and admitStrict enforce limits, freeze outputs, and never invoke getters", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        entries: Schema.Array(JsonEntry),
        maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 512 })),
        maxNodes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
        maxMembers: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
        maxDepth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))
      })
    )
    await runProp(arb, ({ entries, maxBytes, maxNodes, maxMembers, maxDepth }) => {
      const obj: Record<string, unknown> = {}
      for (const [k, v] of entries.slice(0, 12)) {
        const key = cleanString(k)
        if (key === "__proto__") continue
        obj[key] = typeof v === "string" ? cleanString(v) : v
      }
      const limits = { maxBytes, maxNodes, maxMembers, maxTotalMembers: maxMembers * 2, maxDepth }
      const r1 = BoundedJson.admit(obj, limits)
      if (r1.ok) {
        if (!Object.isFrozen(r1.value)) return false
        if (!isRecord(r1.value)) return false
      }
      const strictLimits = { maxBytes, maxNodes, maxMembers, maxDepth, maxKeyBytes: 1024, maxStringBytes: 1024 }
      const r2 = BoundedJson.admitStrict(obj, strictLimits)
      if (r2.ok && !Object.isFrozen(r2.value)) return false

      // Getter non-execution invariant: getters MUST be rejected without ever firing.
      let getterCalled = false
      const withGetter = Object.defineProperty({}, "trap", {
        enumerable: true,
        get() {
          getterCalled = true
          return 1
        }
      })
      const rg = BoundedJson.admit(withGetter, limits)
      if (rg.ok || getterCalled) return false
      return true
    })
  })

  it("sortCollections canonicalizes Sets and Maps identically regardless of insertion order", async () => {
    const arb = Arbitrary.schema(Schema.Array(Schema.String))
    await runProp(arb, (raw) => {
      const items = raw.slice(0, 12).map(cleanString)
      const s1 = sortCollections(new Set(items))
      const s2 = sortCollections(new Set([...items].reverse()))
      const m1 = sortCollections(new Map(items.map((k, i) => [k, i])))
      const m2 = sortCollections(new Map([...items.map((k, i) => [k, i] as const)].reverse()))
      return (
        JSON.stringify([...(s1 as Set<string>)]) === JSON.stringify([...(s2 as Set<string>)])
        && JSON.stringify([...(m1 as Map<string, number>).keys()])
          === JSON.stringify([...(m2 as Map<string, number>).keys()])
      )
    })
  })
})
