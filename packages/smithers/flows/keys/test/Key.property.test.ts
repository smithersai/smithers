import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Canonical } from "@smthrs/canonical"
import { Effect, Result, Schema } from "effect"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import * as Keys from "../src/index.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const attemptKey = (value: unknown): Result.Result<string, Schema.SchemaError> =>
  Effect.runSync(
    Effect.result(Schema.decodeUnknownEffect(Keys.DerivedKey)(value)).pipe(Effect.provide(NodeCrypto.layer))
  )

const attemptCanonical = (value: unknown): Result.Result<string, Schema.SchemaError> =>
  Effect.runSync(Effect.result(Schema.decodeUnknownEffect(Canonical)(value)))

describe("Key properties", () => {
  it("derives a deterministic fixed-width key or fails typed, for arbitrary JSON", () => {
    // Equal inputs must produce byte-identical keys of the invariant shape
    // `key1_` + 64 lowercase hex, whatever the input size or content; inputs
    // with no canonical form must fail with a typed SchemaError both times.
    FastCheck.assert(
      FastCheck.property(FastCheck.jsonValue({ stringUnit: "binary" }), (value) => {
        const first = attemptKey(value)
        const second = attemptKey(value)
        if (Result.isFailure(first)) {
          expect(first.failure._tag).toBe("SchemaError")
          expect(Result.isFailure(second)).toBe(true)
          return
        }
        expect(first.success).toMatch(/^key1_[0-9a-f]{64}$/)
        expect(first.success.length).toBe(69)
        expect(Result.isSuccess(second) ? second.success : undefined).toBe(first.success)
      }),
      { ...params, examples: [[-0], [""], [{}], [[]], [{ "\ud800": 1 }]] }
    )
  })

  it("preserves equality of canonical documents", () => {
    // SHA-256 is not mathematically injective, so this property asserts only
    // the guarantee the derivation can make: one canonical byte sequence
    // always maps to one deterministic key. Re-parsing the canonical document
    // produces a second value with exactly those bytes.
    FastCheck.assert(
      FastCheck.property(FastCheck.jsonValue({ stringUnit: "binary" }), (value) => {
        const canonical = attemptCanonical(value)
        if (Result.isFailure(canonical)) {
          expect(Result.isFailure(attemptKey(value))).toBe(true)
          return
        }
        const original = attemptKey(value)
        const reparsed = attemptKey(JSON.parse(canonical.success))
        expect(Result.isSuccess(original)).toBe(true)
        expect(Result.isSuccess(reparsed)).toBe(true)
        expect(
          Result.isSuccess(original) && Result.isSuccess(reparsed)
            ? reparsed.success
            : undefined
        ).toBe(Result.isSuccess(original) ? original.success : undefined)
      }),
      {
        ...params,
        examples: [
          [-0],
          [{ b: 2, a: 1 }],
          [["a", "bc"]],
          [{ a: { b: 1 } }],
          [{ "\ud800": 1 }]
        ]
      }
    )
  })
})
