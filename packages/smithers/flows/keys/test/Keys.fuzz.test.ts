import { WebCrypto } from "@smthrs/crypto"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { deriveKey, KeyV1, StoredKey } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const clean = (s: string) => s.replace(/[\uD800-\uDFFF]/g, "_")

describe("@smthrs/keys fuzz invariants", () => {
  it("deriveKey is deterministic, permutation-invariant, domain-separated, and StoredKey-valid", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        domain: Schema.String,
        a: Schema.String,
        b: Schema.Int,
        c: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ domain, a, b, c }) =>
          Effect.gen(function*() {
            const d = clean(domain)
            const av = clean(a)
            const k1 = yield* deriveKey({ domain: d, a: av, b, c })
            const k2 = yield* deriveKey({ c, b, a: av, domain: d })
            if (k1 !== k2) return false
            if (!Schema.is(KeyV1)(k1) || !Schema.is(StoredKey)(k1)) return false
            // Domain separation: changing domain MUST yield a distinct key.
            const kOther = yield* deriveKey({ domain: `${d}_alt`, a: av, b, c })
            return k1 !== kOther
          }),
        { seed, executions }
      ).pipe(Effect.provide(WebCrypto.layer))
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("StoredKey schema never throws defects on arbitrary garbage strings", async () => {
    const arb = Arbitrary.schema(Schema.String)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (text) => {
          const valid = Schema.is(StoredKey)(text)
          const matchesFormat = /^key1_[0-9a-f]{64}$/.test(text)
          return valid === matchesFormat
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
