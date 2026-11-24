import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BoundedJson, CanonicalError, canonicalize, sortCollections } from "../src/index.ts"
import * as IssuePath from "../src/IssuePath.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "150"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

class Box {
  readonly label: string
  constructor(label: string) {
    this.label = label
  }
}

describe("@smthrs/canonical deep fuzz invariants (sortCollections, BoundedJson, canonicalize, IssuePath)", () => {
  it("sortCollections handles nested Sets/Maps, TypedArrays, Dates, RegExps, Errors, class instances, DAGs, cycles, large inline-limit trees, accessors, and Proxies", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        seedNum: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
        tags: Schema.Array(Schema.Literals(["a", "b", "c", "z", "λ", ""])).check(
          Schema.isMinLength(2),
          Schema.isMaxLength(6)
        ),
        longLen: Schema.Literals([16, 400, 1200]),
        withCycle: Schema.Boolean,
        withProxy: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ seedNum, tags, longLen, withCycle, withProxy }) =>
          Effect.sync(() => {
            const bigA = "A".repeat(longLen) + tags[0]!
            const bigB = "A".repeat(longLen) + tags[tags.length - 1]!
            const shared = {
              shared: true,
              bytes: new Uint8Array([seedNum & 0xff, 1, 2]),
              view: new DataView(new ArrayBuffer(4))
            }
            const cyclicA: Record<string, unknown> = { tag: "cyc", n: seedNum }
            const cyclicB: Record<string, unknown> = { tag: "cyc", n: seedNum + 1 }
            if (withCycle) {
              cyclicA["self"] = cyclicA
              cyclicB["self"] = cyclicB
            }

            const makeItem = (t: string, idx: number): unknown => {
              switch (idx % 10) {
                case 0:
                  return new Date(1_700_000_000_000 + seedNum * 1000 + idx)
                case 1:
                  return new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
                case 2:
                  return new Box(t + bigA)
                case 3:
                  return BigInt(seedNum + idx)
                case 4:
                  return new Int32Array([seedNum, idx, -idx])
                case 5:
                  return Symbol.for(`sym.${t}`)
                case 6:
                  return new Set<unknown>([
                    bigB,
                    bigA,
                    shared,
                    null,
                    undefined,
                    NaN,
                    -0,
                    Infinity,
                    -Infinity,
                    true,
                    false
                  ])
                case 7: {
                  const o = Object.create(null) as Record<string, unknown>
                  o["k"] = t
                  o["big"] = bigB
                  Object.defineProperty(o, "getter", {
                    enumerable: true,
                    get: () => {
                      throw new Error("getter boom")
                    }
                  })
                  return o
                }
                case 8:
                  return new Error(`err-${t}`)
                default:
                  return () => idx
              }
            }

            const items = tags.map((t, i) => makeItem(t, i))
            const reversed = [...items].reverse()
            const s1 = new Set<unknown>([...items, cyclicA, cyclicB, shared])
            const s2 = new Set<unknown>([...reversed, cyclicB, cyclicA, shared])

            const m1 = new Map<unknown, unknown>([
              [bigB, { s: s1, shared }],
              [bigA, { s: s2, shared }],
              [cyclicA, new Set([1, 2, 3])],
              [cyclicB, new Set([3, 2, 1])]
            ])
            const m2 = new Map<unknown, unknown>([...m1.entries()].reverse())

            const sortedS1 = sortCollections(s1)
            const sortedS2 = sortCollections(s2)
            expect(sortedS1.size).toBe(s1.size)
            expect(sortedS2.size).toBe(s2.size)
            // Idempotence
            const sortedS1Twice = sortCollections(sortedS1)
            expect(sortedS1Twice.size).toBe(sortedS1.size)

            const sortedM1 = sortCollections(m1)
            const sortedM2 = sortCollections(m2)
            expect(sortedM1.size).toBe(m1.size)
            expect(sortedM2.size).toBe(m2.size)

            // Large tree > 1024 inlineLimit forces RankNode structural comparison across shared & distinct branches
            const bigTree1 = new Set([
              { a: bigA, nested: { b: bigB, c: bigA, d: new Set([bigB, bigA]) } },
              { a: bigA, nested: { b: bigA, c: bigB, d: new Set([bigA, bigB]) } },
              { a: bigB, nested: { b: bigB, c: bigA, d: new Set([bigB]) } }
            ])
            const bigTree2 = new Set([...bigTree1].reverse())
            const st1 = [...sortCollections(bigTree1)]
            const st2 = [...sortCollections(bigTree2)]
            expect(JSON.stringify(st1.map((x) => x.a))).toBe(JSON.stringify(st2.map((x) => x.a)))

            // Throwing Proxy triggers uninspectable fallback safely without throwing
            if (withProxy) {
              const badProxy = new Proxy(
                {},
                {
                  ownKeys() {
                    throw new Error("trap")
                  }
                }
              )
              const setWithProxy = new Set<unknown>([badProxy, "ok", new Map([[badProxy, 1]])])
              const res = sortCollections(setWithProxy)
              expect(res.size).toBe(3)
            }

            // Clean primitives/objects pass through untouched
            expect(sortCollections(42)).toBe(42)
            expect(sortCollections("plain")).toBe("plain")
            expect(sortCollections({ a: 1, b: [2, 3] })).toEqual({ a: 1, b: [2, 3] })
            return true
          }),
        { executions: Math.min(executions, 80), seed }
      )
    )
    assertPassed(report)
  })

  it("BoundedJson.admit, admitStrict, and encodedStringBytes enforce every limit and refusal code", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "ok",
          "depth",
          "nodes",
          "bytes",
          "members",
          "totalMembers",
          "keyLong",
          "keyReserved",
          "keySurrogate",
          "stringLong",
          "stringSurrogate",
          "nonFinite",
          "arrayExtra",
          "arraySparse",
          "arrayAccessor",
          "symbolKey",
          "accessorProp",
          "nonPlain",
          "cycle",
          "proxyThrow",
          "utf8Escapes"
        ]),
        strict: Schema.Boolean,
        boundedText: Schema.Boolean,
        ordinaryRecords: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, strict, boundedText, ordinaryRecords }) =>
          Effect.sync(() => {
            const limits: BoundedJson.StrictLimits = {
              maxDepth: 3,
              maxNodes: 10,
              maxBytes: 90,
              maxMembers: 4,
              maxStringBytes: 24,
              maxKeyBytes: 16
            }
            const run = (val: unknown) =>
              strict
                ? BoundedJson.admitStrict(val, limits, { boundedText, ordinaryRecords })
                : BoundedJson.admit(val, { ...limits, maxTotalMembers: 6 })

            switch (mode) {
              case "ok": {
                const r = run({ a: 1, b: [true, "hi"] })
                expect(r.ok).toBe(true)
                break
              }
              case "depth": {
                const r = run({ a: { b: { c: { d: 1 } } } })
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("depth") }
                break
              }
              case "nodes": {
                const r = run([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(["nodes", "members", "bytes"]).toContain(r.code) }
                break
              }
              case "bytes": {
                const r = run({
                  a: "12345678901234567890",
                  b: "12345678901234567890",
                  c: "12345678901234567890",
                  d: "12345678901234567890"
                })
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("bytes") }
                break
              }
              case "members": {
                const r = run({ a: 1, b: 2, c: 3, d: 4, e: 5 })
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("members") }
                break
              }
              case "totalMembers": {
                const r = BoundedJson.admit({ a: [1, 2, 3], b: [4, 5, 6] }, { ...limits, maxTotalMembers: 4 })
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("members") }
                break
              }
              case "keyLong": {
                const r = run({ ["k".repeat(32)]: 1 })
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("key") }
                break
              }
              case "keyReserved": {
                const obj = Object.create(null) as Record<string, unknown>
                obj["__proto__"] = 1
                const r = BoundedJson.admitStrict({ constructor: 1 }, limits, { boundedText, ordinaryRecords })
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("key") }
                const r2 = run(obj)
                if (strict) expect(r2.ok).toBe(false)
                break
              }
              case "keySurrogate": {
                const r = run({ ["bad\uD800key"]: 1 })
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("key") }
                break
              }
              case "stringLong": {
                const r = run({ s: "x".repeat(40) })
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("string") }
                break
              }
              case "stringSurrogate": {
                const r = run({ s: "hi\uDC00there" })
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("string") }
                break
              }
              case "nonFinite": {
                const r = run({ n: Number.NaN })
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("number") }
                break
              }
              case "arrayExtra": {
                const arr: Array<unknown> & { extra?: number } = [1, 2]
                arr.extra = 3
                const r = run(arr)
                if (strict) {
                  expect(r.ok).toBe(false)
                  if (!r.ok) { if ("code" in r) expect(r.code).toBe("arrayExtra") }
                }
                break
              }
              case "arraySparse": {
                const arr = new Array(2)
                arr[1] = 1
                const r = run(arr)
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(["arrayExtra", "arrayMember"]).toContain(r.code) }
                break
              }
              case "arrayAccessor": {
                const arr: Array<unknown> = [1]
                Object.defineProperty(arr, "0", { enumerable: true, get: () => 1 })
                const r = run(arr)
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("arrayMember") }
                break
              }
              case "symbolKey": {
                const obj: Record<PropertyKey, unknown> = { [Symbol("s")]: 1 }
                const r = run(obj)
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("symbol") }
                break
              }
              case "accessorProp": {
                const obj = {}
                Object.defineProperty(obj, "a", { enumerable: true, get: () => 1 })
                const r = run(obj)
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("accessor") }
                const nonEnum = {}
                Object.defineProperty(nonEnum, "hidden", { enumerable: false, value: 1 })
                const r2 = run(nonEnum)
                if (strict) expect(r2.ok).toBe(false)
                else expect(r2.ok).toBe(true)
                break
              }
              case "nonPlain": {
                const r = run(new Date())
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("object") }
                break
              }
              case "cycle": {
                const cyc: Record<string, unknown> = {}
                cyc["self"] = cyc
                const r = run(cyc)
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("cycle") }
                break
              }
              case "proxyThrow": {
                const p = new Proxy(
                  {},
                  {
                    getPrototypeOf() {
                      throw new Error("boom")
                    }
                  }
                )
                const r = run(p)
                expect(r.ok).toBe(false)
                if (!r.ok) { if ("code" in r) expect(r.code).toBe("inspection") }
                break
              }
              case "utf8Escapes": {
                const sample = "a\"\\\b\f\n\r\t\u0001é€😀"
                const bytes = BoundedJson.encodedStringBytes(sample)
                expect(bytes).toBe(Buffer.byteLength(JSON.stringify(sample)))
                expect(BoundedJson.encodedStringBytes(sample, 4)).toBeUndefined()
                expect(BoundedJson.encodedStringBytes("\uD800")).toBeUndefined()
                expect(BoundedJson.encodedStringBytes("\uD83D")).toBeUndefined()
                expect(BoundedJson.encodedStringBytes("\uDC00")).toBeUndefined()
                break
              }
            }
            return true
          }),
        { executions: Math.min(executions, 120), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("canonicalize edge errors and IssuePath.firstPath formatting invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "cycle",
          "nan",
          "inf",
          "bigint",
          "symbol",
          "fn",
          "surrogate",
          "undefProp",
          "arrayUndef",
          "issuePath"
        ]),
        key: Schema.Literals(["alpha", "0", "a.b", "nested"])
      })
    )

    const TargetSchema = Schema.Struct({
      nested: Schema.Struct({
        items: Schema.Array(Schema.Struct({ count: Schema.Number }))
      })
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, key }) =>
          Effect.sync(() => {
            if (kind === "issuePath") {
              const res = Schema.decodeUnknownExit(TargetSchema)({ nested: { items: [{ count: "bad" }] } })
              expect(res._tag).toBe("Failure")
              if (res._tag === "Failure") {
                const err = res.cause.reasons[0]
                if (err && err._tag === "Fail") {
                  const p = IssuePath.firstPath(err.error)
                  expect(p).toContain("nested")
                  expect(p).toContain("items")
                }
              }
              const topRes = Schema.decodeUnknownExit(Schema.Number)("not-a-num")
              if (topRes._tag === "Failure") {
                const err = topRes.cause.reasons[0]
                if (err && err._tag === "Fail") {
                  expect(typeof IssuePath.firstPath(err.error)).toBe("string")
                }
              }
              return true
            }

            if (kind === "undefProp") {
              expect(canonicalize({ [key]: undefined, z: 1 })).toBe("{\"z\":1}")
              return true
            }
            if (kind === "arrayUndef") {
              expect(canonicalize([undefined])).toBe("[null]")
              return true
            }

            const bad: unknown = kind === "cycle"
              ? (() => {
                const o: Record<string, unknown> = {}
                o["self"] = o
                return o
              })()
              : kind === "nan"
              ? Number.NaN
              : kind === "inf"
              ? Number.POSITIVE_INFINITY
              : kind === "bigint"
              ? 1n
              : kind === "symbol"
              ? Symbol("x")
              : kind === "fn"
              ? () => 1
              : "bad\uD800"
            expect(() => canonicalize(bad)).toThrow(CanonicalError)
            return true
          }),
        { executions: Math.min(executions, 100), seed: seed + 2 }
      )
    )
    assertPassed(report)
  })
})
