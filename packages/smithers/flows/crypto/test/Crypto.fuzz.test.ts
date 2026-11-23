import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { digest, digestStream, digestSync, makeDigestPartsSync, Sha256Error, Uuid, WebCrypto } from "../src/index.ts"

const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/crypto fuzz invariants", () => {
  it("digestSync, WebCrypto digest, and chunked digestStream agree byte-for-byte", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        bytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
        chunkSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ bytes, chunkSize }) =>
          Effect.gen(function*() {
            const payload = new Uint8Array(bytes.slice(0, 256))
            const syncHash = digestSync(payload)
            const asyncHash = yield* digest(payload)
            if (syncHash !== asyncHash) return false
            const chunks: Array<Uint8Array> = []
            for (let i = 0; i < payload.length; i += chunkSize) {
              chunks.push(payload.subarray(i, i + chunkSize))
            }
            const streamHash = yield* digestStream(Stream.fromIterable(chunks))
            return streamHash === syncHash
          }),
        { seed, executions }
      ).pipe(Effect.provide(WebCrypto.layer))
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("makeDigestPartsSync prefix cache matches digestSync across arbitrary partitions and call sequences", async () => {
    const digestParts = makeDigestPartsSync()
    const arb = Arbitrary.schema(
      Schema.Struct({
        parts: Schema.Array(Schema.String),
        second: Schema.Array(Schema.String)
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ parts, second }) => {
          const a = parts.slice(0, 8)
          const b = [...a.slice(0, Math.min(2, a.length)), ...second.slice(0, 6)]
          if (!a.every((x) => isWellFormed(x))) {
            try {
              digestParts(a)
              return false
            } catch (err) {
              return err instanceof Sha256Error
            }
          }
          if (digestParts(a) !== digestSync(a.join(""))) return false
          if (!b.every((x) => isWellFormed(x))) {
            try {
              digestParts(b)
              return false
            } catch (err) {
              return err instanceof Sha256Error
            }
          }
          return digestParts(b) === digestSync(b.join(""))
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Uuid.v5 always produces deterministic RFC 4122 v5 UUIDs", async () => {
    const ns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
    const arb = Arbitrary.schema(Schema.String)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (name) =>
          Effect.gen(function*() {
            const wellFormed = isWellFormed(name)
            if (!wellFormed) {
              const exit = yield* Effect.exit(Uuid.v5(ns, name))
              return exit._tag === "Failure"
            }
            const u1 = yield* Uuid.v5(ns, name)
            const u2 = yield* Uuid.v5(ns, name)
            const uAlt = yield* Uuid.v5(ns, `${name}!`)
            if (u1 !== u2 || u1 === uAlt) return false
            if (!Uuid.isUuid(u1)) return false
            // RFC 4122 version 5 nibble & variant bits.
            return u1[14] === "5" && /[89ab]/.test(u1[19]!)
          }),
        { seed, executions }
      ).pipe(Effect.provide(WebCrypto.layer))
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
