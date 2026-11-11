import { Cause, Effect, Exit } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import { Uuid, WebCrypto } from "../src/index.ts"

const v5 = (namespace: string, name: string) =>
  Effect.runPromise(Uuid.v5(namespace, name).pipe(Effect.provide(WebCrypto.layer)))

const defectOf = (program: Effect.Effect<string>): unknown => {
  const result = Effect.runSyncExit(program)
  if (Exit.isFailure(result)) return Cause.squash(result.cause)
  throw new Error("Expected UUID generation to fail")
}

const digestHost = (output: unknown): typeof EffectDigest.Digest.Service =>
  EffectDigest.Digest.of({
    digest: () => Effect.succeed(output as Uint8Array),
    digestHex: () => Effect.die(new Error("Unexpected digestHex call"))
  })

// RFC 9562 Appendix A.4 and the namespaces of its §6.6.
const DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
const URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"

describe("Uuid.v5", () => {
  it("matches RFC 9562's example for www.example.com in the DNS namespace", async () => {
    expect(await v5(DNS, "www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2")
  })

  it("is the same for the same namespace and name, and differs by either", async () => {
    const a = await v5(URL, "https://example.com/")
    expect(await v5(URL, "https://example.com/")).toBe(a)
    expect(await v5(DNS, "https://example.com/")).not.toBe(a)
    expect(await v5(URL, "https://example.com")).not.toBe(a)
  })

  it("sets version 5 and the RFC variant, in lowercase, whatever the namespace's case", async () => {
    const id = await v5(DNS.toUpperCase(), "日本語")
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id).toBe(await v5(DNS, "日本語"))
  })

  it.each([
    ["empty", "", "4ebd0208-8328-5d69-8c44-ec50939c0967"],
    ["lowest surrogate pair", "\ud800\udc00", "1b271d11-85f7-5d66-81d2-ba648116e996"],
    ["highest surrogate pair", "\udbff\udfff", "b3e2daa1-4e3f-5c57-9cef-281b2f2ae5b3"],
    ["embedded surrogate pair", "a\ud83d\ude00z", "f800937e-746d-57ac-9ef3-bc154a2ddf0d"],
    ["consecutive surrogate pairs", "\ud83d\ude00\ud800\udc00", "c3c60373-fe16-53a0-a74f-ef60036c3e59"],
    ["replacement character", "a\ufffd", "a05a5076-f5f6-52f6-b9a8-62688ee58a0a"],
    ["composed text", "\u00e9", "ebfe0af8-3997-5ade-b634-ba92cf69f557"],
    ["decomposed text", "e\u0301", "39004b7f-2a0b-588c-88f7-aa24552a7636"]
  ])("preserves the UUID of a well-formed name: %s", async (_label, name, expected) => {
    expect(await v5(DNS, name)).toBe(expected)
  })

  it.each([
    ["trailing high surrogate", "a\ud800"],
    ["trailing low surrogate", "a\udfff"],
    ["leading high surrogate", "\udbffx"],
    ["leading low surrogate", "\udc00x"],
    ["embedded high surrogate", "a\ud800z"],
    ["embedded low surrogate", "a\udfffz"],
    ["reversed surrogate pair", "\udc00\ud800"],
    ["two high surrogates", "\ud800\udbff"],
    ["two low surrogates", "\udc00\udfff"],
    ["unpaired surrogate after a pair", "\ud83d\ude00\ud800"]
  ])("rejects a name with a %s before calling the host", (_label, name) => {
    const unavailable = EffectDigest.Digest.of({
      digest: () => Effect.die(new Error("The host must not be called")),
      digestHex: () => Effect.die(new Error("The host must not be called"))
    })
    const defect = defectOf(Uuid.v5(DNS, name).pipe(Effect.provideService(EffectDigest.Digest, unavailable)))
    expect(defect).toBeInstanceOf(TypeError)
    expect(defect).toHaveProperty("message", "Uuid.v5: name contains an unpaired UTF-16 surrogate")
  })

  it.each([0, 1, 15, 16, 19, 21, 32])("rejects a %i-byte host digest", (length) => {
    const defect = defectOf(
      Uuid.v5(DNS, "x").pipe(
        Effect.provideService(EffectDigest.Digest, digestHost(new Uint8Array(length)))
      )
    )
    expect(defect).toBeInstanceOf(TypeError)
    expect(defect).toHaveProperty("message", "Uuid.v5: host digest must be a 20-byte Uint8Array")
  })

  it.each([
    ["plain array", Array.from({ length: 20 }, () => 0)],
    ["string", "x".repeat(20)],
    ["other typed array", new Uint16Array(20)],
    ["null", null],
    ["undefined", undefined]
  ])("rejects a non-byte host digest: %s", (_label, output) => {
    const defect = defectOf(Uuid.v5(DNS, "x").pipe(Effect.provideService(EffectDigest.Digest, digestHost(output))))
    expect(defect).toBeInstanceOf(TypeError)
    expect(defect).toHaveProperty("message", "Uuid.v5: host digest must be a 20-byte Uint8Array")
  })

  it("accepts exactly 20 host bytes without mutating a plain Uint8Array", () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, index) => index)
    const snapshot = bytes.slice()
    expect(Effect.runSync(
      Uuid.v5(DNS, "x").pipe(
        Effect.provideService(EffectDigest.Digest, digestHost(bytes))
      )
    )).toBe("00010203-0405-5607-8809-0a0b0c0d0e0f")
    expect(bytes).toEqual(snapshot)
  })

  it("admits exactly the names that survive a UTF-8 round trip", async () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.oneof(
          FastCheck.string({ unit: "binary" }),
          FastCheck.array(
            FastCheck.oneof(
              FastCheck.integer({ min: 0, max: 0xffff }),
              FastCheck.integer({ min: 0xd800, max: 0xdfff })
            ),
            { maxLength: 40 }
          ).map((units) => String.fromCharCode(...units))
        ),
        async (name) => {
          if (decoder.decode(encoder.encode(name)) === name) {
            expect(Uuid.isUuid(await v5(DNS, name))).toBe(true)
          } else {
            await expect(v5(DNS, name)).rejects.toThrow("name contains an unpaired UTF-16 surrogate")
          }
        }
      ),
      {
        numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
        ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
        examples: [[""], ["a\ud800"], ["a\udfff"], ["a\ufffd"], ["\ud800\udc00"], ["\udbff\udfff"], ["\ufeff"]],
        interruptAfterTimeLimit: 20_000,
        markInterruptAsFailure: true
      }
    )
  })

  it("rejects generated unpaired surrogates surrounded by valid text", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.array(FastCheck.integer({ min: 0, max: 0x7f }), { maxLength: 40 })
          .map((codes) => String.fromCharCode(...codes)),
        FastCheck.integer({ min: 0xd800, max: 0xdfff }),
        FastCheck.array(FastCheck.integer({ min: 0, max: 0x7f }), { maxLength: 40 })
          .map((codes) => String.fromCharCode(...codes)),
        async (prefix, surrogate, suffix) => {
          await expect(v5(DNS, prefix + String.fromCharCode(surrogate) + suffix))
            .rejects.toThrow("name contains an unpaired UTF-16 surrogate")
        }
      ),
      {
        numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
        ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
        interruptAfterTimeLimit: 20_000,
        markInterruptAsFailure: true
      }
    )
  })

  it("dies on a namespace that isn't a UUID", async () => {
    await expect(v5("not-a-uuid", "x")).rejects.toThrow("namespace is not a UUID")
  })
})

describe("Uuid.isUuid", () => {
  it.each([
    [DNS, true],
    [DNS.toUpperCase(), true],
    ["6ba7b8109dad11d180b400c04fd430c8", false],
    ["6ba7b810-9dad-11d1-80b4-00c04fd430c", false],
    ["", false]
  ])("%s is %s", (value, expected) => {
    expect(Uuid.isUuid(value)).toBe(expected)
  })
})
