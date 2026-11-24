import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Redacted, Result, Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { describe, expect, it } from "vitest"
import { deriveKey, digest, KeyDerivationError } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "250")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

describe("@smthrs/keys Wave 10 deep fuzz", () => {
  it("unboxes native wrapper objects, handles toJSON, omits member functions, and extracts digest", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        n: Schema.Int.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 })),
        s: Schema.String.check(Schema.isMaxLength(32)),
        b: Schema.Boolean,
        useToJson: Schema.Boolean,
        shareObj: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ n, s, b, useToJson, shareObj }) =>
          Effect.gen(function*() {
            const cleanS = s.replace(/[\uD800-\uDFFF]/g, "a")
            // Boxed Number, String, Boolean unbox identically to primitives
            const boxed = {
              num: new Number(n),
              str: new String(cleanS),
              bool: new Boolean(b),
              ignoredFn: () => 42
            }
            const plain = { num: n, str: cleanS, bool: b }
            const kBoxed = yield* deriveKey(boxed)
            const kPlain = yield* deriveKey(plain)
            if (kBoxed !== kPlain) return false

            const d = digest(kBoxed)
            if (!/^[0-9a-f]{64}$/.test(d)) return false
            if (`key1_${d}` !== kBoxed) return false

            if (useToJson) {
              const withToJson = {
                x: {
                  inner: n,
                  toJSON(key: string) {
                    return { key, inner: this.inner, label: cleanS }
                  }
                }
              }
              const kJson = yield* deriveKey(withToJson)
              const kExpected = yield* deriveKey({ x: { key: "x", inner: n, label: cleanS } })
              if (kJson !== kExpected) return false
            }

            if (shareObj) {
              const shared = { v: n, s: cleanS }
              const kShared = yield* deriveKey({
                first: shared,
                second: [shared],
                third: new Date(1_700_000_000_000 + Math.abs(n))
              })
              if (digest(kShared).length !== 64) return false
            }

            return true
          }).pipe(Effect.provide(EffectDigest.layerWebCrypto)),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  }, 60_000)

  it(
    "refuses Redacted, invalid Date, functions in root/element, stripped URLs, and prototype-stripped collections",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          kind: Schema.Literals([
            "redactedRoot",
            "redactedNested",
            "redactedToJson",
            "invalidDate",
            "boxedNaN",
            "boxedInfinity",
            "fnRoot",
            "fnElement",
            "symbolRoot",
            "symbolElement",
            "undefinedElement",
            "urlNullProto",
            "urlObjectProto",
            "mapObjectProto",
            "setNullProto",
            "boxedBigInt"
          ]),
          payload: Schema.String.check(Schema.isMaxLength(24))
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ kind, payload }) =>
            Effect.gen(function*() {
              const safe = payload.replace(/[^a-zA-Z0-9_-]/g, "x") || "a"
              let bad: unknown
              switch (kind) {
                case "redactedRoot":
                  bad = Redacted.make(safe)
                  break
                case "redactedNested":
                  bad = { secret: Redacted.make(safe) }
                  break
                case "redactedToJson":
                  bad = { toJSON: () => Redacted.make(safe) }
                  break
                case "invalidDate":
                  bad = { when: new Date(Number.NaN) }
                  break
                case "boxedNaN":
                  bad = { x: new Number(Number.NaN) }
                  break
                case "boxedInfinity":
                  bad = [new Number(Number.POSITIVE_INFINITY)]
                  break
                case "fnRoot":
                  bad = () => safe
                  break
                case "fnElement":
                  bad = [1, () => safe]
                  break
                case "symbolRoot":
                  bad = Symbol(safe)
                  break
                case "symbolElement":
                  bad = [Symbol(safe)]
                  break
                case "undefinedElement":
                  bad = [1, undefined]
                  break
                case "urlNullProto": {
                  const u = new URL(`https://example.com/${safe}`)
                  Object.setPrototypeOf(u, null)
                  bad = { u }
                  break
                }
                case "urlObjectProto": {
                  const u = new URL(`https://example.com/${safe}`)
                  Object.setPrototypeOf(u, Object.prototype)
                  bad = { u }
                  break
                }
                case "mapObjectProto": {
                  const m = new Map([[safe, 1]])
                  Object.setPrototypeOf(m, Object.prototype)
                  bad = { m }
                  break
                }
                case "setNullProto": {
                  const st = new Set([safe])
                  Object.setPrototypeOf(st, null)
                  bad = { st }
                  break
                }
                case "boxedBigInt":
                  bad = { b: Object(1n) }
                  break
              }
              const res = yield* Effect.result(deriveKey(bad))
              if (!Result.isFailure(res)) return false
              if (!Schema.is(KeyDerivationError)(res.failure)) return false
              return res.failure.code === "canonicalization_failed"
            }).pipe(Effect.provide(EffectDigest.layerWebCrypto)),
          { seed: seed + 1, executions }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    60_000
  )
})
