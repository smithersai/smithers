import { Sha256, syncCrypto } from "@smthrs/crypto"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { describe, expect, it } from "vitest"
import { ArtifactStore } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/artifacts fuzz content-addressing & concurrency invariants", () => {
  it("MemoryArtifactStore preserves exact bytes, SHA-256 content addressing, and idempotency under concurrent FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Array(
        Schema.Struct({
          bytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
          deleteAfter: Schema.Boolean
        })
      )
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (items) =>
          Effect.gen(function*() {
            const store = ArtifactStore.makeMemory()
            const payloads = items.slice(0, 6).map((item) => new Uint8Array(item.bytes.slice(0, 128)))
            // Concurrent puts of the same & distinct blobs under FuzzSimulation.
            const digests = yield* Effect.forEach(
              payloads,
              (bytes) =>
                Effect.gen(function*() {
                  yield* Effect.yieldNow
                  const d1 = yield* store.put(bytes)
                  const d2 = yield* store.put(bytes)
                  if (d1 !== d2 || d1 !== Sha256.digestSync(bytes)) return null
                  return d1
                }),
              { concurrency: "unbounded" }
            )
            for (let i = 0; i < payloads.length; i++) {
              const d = digests[i]
              if (d === null || d === undefined) return false
              if (!(yield* store.has(d))) return false
              const actual = yield* store.get(d)
              const expected = payloads[i]!
              if (actual.length !== expected.length) return false
              for (let j = 0; j < expected.length; j++) {
                if (actual[j] !== expected[j]) return false
              }
            }
            return true
          }).pipe(Effect.provideService(EffectDigest.Digest, syncCrypto)),
        { seed, executions, execution: FuzzSimulation.execution() }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
