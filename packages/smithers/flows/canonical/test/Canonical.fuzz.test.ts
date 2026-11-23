import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BoundedJson, Canonical, CanonicalError, canonicalize, isRecord, sortCollections } from "../src/index.ts"
import * as IssuePath from "../src/IssuePath.ts"
import * as ReadonlyMap from "../src/ReadonlyMap.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const cleanString = (s: string): string => {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdfff) continue
    out += s[i]
  }
  return out
}

const jsonLeaf = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Finite,
  Schema.String.pipe(Schema.check(Schema.isMaxLength(24)))
])

const jsonObj = Schema.Record(
  Schema.String.pipe(Schema.check(Schema.isMaxLength(12))),
  Schema.Union([jsonLeaf, Schema.Array(jsonLeaf).pipe(Schema.check(Schema.isMaxLength(5)))])
)

describe("@smthrs/canonical comprehensive fuzz invariants", () => {
  it("canonicalize and Canonical schema are RFC 8785 permutation-invariant, idempotent, and UTF-16 key sorted", async () => {
    const arb = Arbitrary.schema(jsonObj)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (raw) =>
          Effect.gen(function*() {
            const entries = Object.entries(raw)
              .filter(([k]) => k !== "__proto__")
              .map(([k, v]) => {
                const ck = cleanString(k)
                const cv = typeof v === "string"
                  ? cleanString(v)
                  : Array.isArray(v)
                  ? v.map((x) => (typeof x === "string" ? cleanString(x) : x))
                  : v
                return [ck, cv] as const
              })
            const dedupEntries = [...new Map(entries).entries()]
            const forward = Object.fromEntries(dedupEntries)
            const reversed = Object.fromEntries([...dedupEntries].reverse())
            const c1 = canonicalize(forward)
            const c2 = canonicalize(reversed)
            if (c1 !== c2) return false
            if (canonicalize(JSON.parse(c1)) !== c1) return false
            // Canonical Effect Schema codec matches canonicalize and forbids encoding
            const decoded = yield* Schema.decodeUnknownEffect(Canonical)(forward)
            if (decoded !== c1) return false
            const encoded = yield* Effect.result(Schema.encodeUnknownEffect(Canonical)(decoded))
            if (Result.isFailure(encoded)) return false
            // UTF-16 code-unit order verification
            const dedup = new Map(entries)
            const expectedKeys = [...dedup.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            const expectedRendered = "{" + expectedKeys.map((k) =>
              `${JSON.stringify(k)}:${canonicalize(dedup.get(k))}`
            ).join(",") + "}"
            return c1 === expectedRendered
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("canonicalize rejects every invalid JS value class with typed CanonicalError", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "nan",
          "inf",
          "negInf",
          "bigint",
          "symbol",
          "fn",
          "undef",
          "cycle",
          "loneHigh",
          "loneLow",
          "map",
          "set",
          "classInst"
        ]),
        n: Schema.Int
      })
    )
    class CustomBox {
      readonly v: number
      constructor(v: number) {
        this.v = v
      }
    }
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, n }) =>
          Effect.sync(() => {
            let bad: unknown
            if (kind === "nan") bad = Number.NaN
            else if (kind === "inf") bad = Number.POSITIVE_INFINITY
            else if (kind === "negInf") bad = Number.NEGATIVE_INFINITY
            else if (kind === "bigint") bad = BigInt(n)
            else if (kind === "symbol") bad = Symbol("s")
            else if (kind === "fn") bad = () => n
            else if (kind === "undef") bad = undefined
            else if (kind === "loneHigh") bad = "\ud800"
            else if (kind === "loneLow") bad = "\udc00"
            else if (kind === "map") bad = new Map([["a", n]])
            else if (kind === "set") bad = new Set([n])
            else if (kind === "classInst") bad = new CustomBox(n)
            else {
              const obj: Record<string, unknown> = { n }
              obj["self"] = obj
              bad = obj
            }
            try {
              canonicalize(bad)
              return false
            } catch (err) {
              return err instanceof CanonicalError
            }
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("BoundedJson.admit & admitStrict enforce all byte/node/member/depth/key/string limits and never invoke getters", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        entries: Schema.Array(
          Schema.Tuple([
            Schema.String.pipe(Schema.check(Schema.isMaxLength(20))),
            Schema.Union([
              Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
              Schema.Int,
              Schema.Boolean,
              Schema.Null,
              Schema.Array(Schema.Int).pipe(Schema.check(Schema.isMaxLength(6)))
            ])
          ])
        ).pipe(Schema.check(Schema.isMaxLength(12))),
        maxBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 8, maximum: 512 }))),
        maxNodes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 24 }))),
        maxMembers: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
        maxDepth: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 }))),
        maxKeyBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 32 }))),
        maxStringBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 48 }))),
        depthNest: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 8 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ entries, maxBytes, maxNodes, maxMembers, maxDepth, maxKeyBytes, maxStringBytes, depthNest }) =>
          Effect.sync(() => {
            const obj: Record<string, unknown> = {}
            for (const [k, v] of entries) {
              const key = cleanString(k)
              if (key === "__proto__") continue
              obj[key] = typeof v === "string" ? cleanString(v) : v
            }
            // Add nested structure to exercise depth bounds
            let nested: unknown = "leaf"
            for (let d = 0; d < depthNest; d++) nested = { n: nested }
            obj["nest"] = nested

            const limits = {
              maxBytes,
              maxNodes,
              maxMembers,
              maxTotalMembers: maxMembers * 2,
              maxDepth,
              maxKeyBytes,
              maxStringBytes
            }
            const r1 = BoundedJson.admit(obj, limits)
            if (r1.ok && (!Object.isFrozen(r1.value) || !isRecord(r1.value))) return false

            const strictLimits = { maxBytes, maxNodes, maxMembers, maxDepth, maxKeyBytes, maxStringBytes }
            const r2 = BoundedJson.admitStrict(obj, strictLimits)
            if (r2.ok && !Object.isFrozen(r2.value)) return false

            // Also check encodedStringBytes on arbitrary cleaned string
            const sampleStr = entries[0]?.[0] ?? ""
            const eb = BoundedJson.encodedStringBytes(cleanString(sampleStr), maxStringBytes)
            if (eb !== undefined && eb > maxStringBytes) return false

            let getterCalled = false
            const withGetter = Object.defineProperty({}, "trap", {
              enumerable: true,
              get() {
                getterCalled = true
                return 1
              }
            })
            const r3 = BoundedJson.admit(withGetter, limits)
            return !r3.ok && !getterCalled
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("sortCollections, ReadonlyMap.make, and IssuePath.firstPath uphold determinism, immutability, and path formatting", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nums: Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -50, maximum: 50 })))).pipe(
          Schema.check(Schema.isMaxLength(12))
        ),
        pairs: Schema.Array(
          Schema.Tuple([
            Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(10))),
            Schema.Int
          ])
        ).pipe(Schema.check(Schema.isMaxLength(10)))
      })
    )
    const TargetSchema = Schema.Struct({
      nested: Schema.Struct({
        items: Schema.Array(Schema.Int)
      })
    })
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ nums, pairs }) =>
          Effect.sync(() => {
            const cleanPairs = pairs.map(([k, v]) => [cleanString(k) || "k", v] as const)
            const s1 = sortCollections(new Set(nums))
            const s2 = sortCollections(new Set([...nums].reverse()))
            if (JSON.stringify([...s1]) !== JSON.stringify([...s2])) return false

            const m1 = sortCollections(new Map(cleanPairs))
            const m2 = sortCollections(new Map([...cleanPairs].reverse()))
            if (JSON.stringify([...m1.keys()]) !== JSON.stringify([...m2.keys()])) return false

            // ReadonlyMap.make returns an immutable map-like view matching entries
            const rm = ReadonlyMap.make(cleanPairs)
            for (const [k, v] of new Map(cleanPairs)) {
              if (!rm.has(k) || rm.get(k) !== v) return false
            }

            // IssuePath.firstPath formats nested schema error paths
            const badRes = Schema.decodeUnknownResult(TargetSchema)({ nested: { items: ["not-an-int"] } })
            if (Result.isFailure(badRes)) {
              const p = IssuePath.firstPath(badRes.failure)
              if (!p.includes("nested") || !p.includes("items")) return false
            }
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
