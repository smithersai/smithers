import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Result, Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { describe, expect, it } from "vitest"
import { DerivedKey, deriveKey, KeyDerivationError, KeyV1, StoredKey } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const failingDigestLayer = Layer.succeed(EffectDigest.Digest)({
  digest: () => Effect.fail(new Error("digest boom") as never),
  digestHex: () => Effect.fail(new Error("digest boom") as never)
})

describe("@smthrs/keys comprehensive fuzz invariants", () => {
  it("deriveKey and DerivedKey agree, are permutation-invariant, domain-separated, and refuse encoding back to input", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        a: Schema.Int,
        b: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9 _-]{0,32}$/))),
        c: Schema.Boolean,
        d: Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9 _-]{0,16}$/))))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ a, b, c, d }) =>
          Effect.gen(function*() {
            const obj1 = { a, b, c, d }
            const obj2 = { d, c, b, a }
            const k1 = yield* deriveKey(obj1)
            const k2 = yield* deriveKey(obj2)
            if (k1 !== k2) return false
            if (!Schema.is(KeyV1)(k1) || !Schema.is(StoredKey)(k1)) return false
            // DerivedKey schema transformation produces identical key
            const viaSchema = yield* Schema.decodeUnknownEffect(DerivedKey)(obj1)
            if (viaSchema !== k1) return false
            // Encoding a DerivedKey back to its input is ALWAYS forbidden
            const enc = yield* Effect.result(Schema.encodeUnknownEffect(DerivedKey)(k1))
            if (Result.isSuccess(enc)) return false
            // Domain separation
            const kOther = yield* deriveKey({ domain: "other", a, b, c, d })
            return kOther !== k1
          }).pipe(Effect.provide(EffectDigest.layerWebCrypto)),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("deriveKey & DerivedKey fail cleanly with KeyDerivationError on non-canonical inputs and digest faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals(["bigint", "nan", "fn", "symbol", "cycle", "digestFault"]),
        num: Schema.Int
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, num }) =>
          Effect.gen(function*() {
            if (kind === "digestFault") {
              const res = yield* Effect.result(deriveKey({ num }).pipe(Effect.provide(failingDigestLayer)))
              if (Result.isSuccess(res)) return false
              return res.failure instanceof KeyDerivationError && res.failure.code === "digest_failed"
            }
            let bad: unknown
            if (kind === "bigint") bad = BigInt(num)
            else if (kind === "nan") bad = Number.NaN
            else if (kind === "fn") bad = () => num
            else if (kind === "symbol") bad = Symbol("s")
            else {
              const cyc: Record<string, unknown> = { num }
              cyc["self"] = cyc
              bad = cyc
            }
            const res = yield* Effect.result(deriveKey(bad).pipe(Effect.provide(EffectDigest.layerWebCrypto)))
            if (Result.isSuccess(res)) return false
            if (!(res.failure instanceof KeyDerivationError) || res.failure.code !== "canonicalization_failed") {
              return false
            }
            const schemaRes = yield* Effect.result(
              Schema.decodeUnknownEffect(DerivedKey)(bad).pipe(Effect.provide(EffectDigest.layerWebCrypto))
            )
            return Result.isFailure(schemaRes)
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("StoredKey strictly validates key1_<64 lowercase hex> format", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(96))),
        Schema.Literals(["key1_" + "a".repeat(64), "key1_" + "A".repeat(64), "key2_" + "a".repeat(64), "key1_short"])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (raw) =>
          Effect.sync(() => {
            const valid = /^key1_[0-9a-f]{64}$/.test(raw)
            return Schema.is(StoredKey)(raw) === valid
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
