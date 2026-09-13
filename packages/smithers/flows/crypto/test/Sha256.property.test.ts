import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto, Effect } from "effect"
import * as FastCheck from "fast-check"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { digest, digestSync, syncCrypto } from "../src/index.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const runDigest = (input: string | Uint8Array) => Effect.runSync(digest(input).pipe(Effect.provide(NodeCrypto.layer)))

const runSynchronousService = (input: string | Uint8Array) =>
  Effect.runSync(Effect.provideService(digest(input), Crypto.Crypto, syncCrypto))

const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

describe("SHA-256 properties", () => {
  it("keeps injected, synchronous, and UTF-8 byte hashing equivalent", () => {
    const encoder = new TextEncoder()
    FastCheck.assert(
      FastCheck.property(FastCheck.string({ unit: "binary" }), (text) => {
        if (!isWellFormed(text)) {
          expect(() => digestSync(text)).toThrow(expect.objectContaining({ code: "invalid_text" }))
          expect(Effect.runSync(Effect.flip(
            Effect.provideService(digest(text), Crypto.Crypto, syncCrypto)
          ))).toMatchObject({ code: "invalid_text" })
          return
        }
        const expected = digestSync(text)
        expect(expected).toMatch(/^[0-9a-f]{64}$/)
        expect(digestSync(encoder.encode(text))).toBe(expected)
        expect(runDigest(text)).toBe(expected)
        expect(runSynchronousService(text)).toBe(expected)
      }),
      { ...params, examples: [[""], ["\ud800"], ["\ud83d\ude00"], ["\ufffd"], ["\0"]] }
    )
  })

  it("hashes exactly the viewed bytes through every entry point", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.uint8Array(),
        FastCheck.uint8Array(),
        FastCheck.uint8Array(),
        (bytes, prefix, suffix) => {
          const backing = new Uint8Array(prefix.length + bytes.length + suffix.length)
          backing.set(prefix)
          backing.set(bytes, prefix.length)
          backing.set(suffix, prefix.length + bytes.length)
          const view = backing.subarray(prefix.length, prefix.length + bytes.length)
          const expected = digestSync(bytes)
          expect(digestSync(view)).toBe(expected)
          expect(runDigest(view)).toBe(expected)
        }
      ),
      {
        ...params,
        examples: [
          [new Uint8Array(0), new Uint8Array([0xff]), new Uint8Array([0xff])],
          [new Uint8Array([0x61, 0x62, 0x63]), new Uint8Array([0xff]), new Uint8Array([0xff])]
        ]
      }
    )
  })
})

/**
 * SHA-256 pads every message to a whole 64-byte block and reserves the last 8
 * bytes of the final block for the bit length, so the block count grows at
 * each length congruent to 56 modulo 64. The random byte property reaches
 * those lengths only by chance, so every transition is pinned here.
 */
const paddingLengths = [55, 56, 57, 63, 64, 65, 119, 120, 121]

/** Deterministic, non-repeating bytes of an exact length. */
const patternBytes = (length: number): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 7 + 13) & 0xff)

/** An oracle that shares no code with the handwritten compressor. */
const nodeDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/**
 * Digests written out as literal hex so the oracle is itself checked. The
 * `abcdbcde...` case is the 448-bit two-block vector from FIPS 180-2 appendix
 * B, which lands exactly on the padding transition; the repeated-"a" cases
 * bracket it at 55, 56 and 64 bytes.
 */
const pinnedVectors = [
  {
    label: "55 repeated \"a\" bytes",
    text: "a".repeat(55),
    hex: "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"
  },
  {
    label: "56 repeated \"a\" bytes",
    text: "a".repeat(56),
    hex: "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
  },
  {
    label: "the FIPS 180-2 448-bit vector",
    text: "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    hex: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  },
  {
    label: "64 repeated \"a\" bytes",
    text: "a".repeat(64),
    hex: "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
  }
] as const

describe("SHA-256 padding transitions", () => {
  it.each(paddingLengths)("hashes %i bytes identically through every entry point", (length) => {
    const bytes = patternBytes(length)
    const expected = nodeDigest(bytes)
    expect(digestSync(bytes)).toBe(expected)
    expect(runDigest(bytes)).toBe(expected)
    expect(runSynchronousService(bytes)).toBe(expected)

    const backing = new Uint8Array(length + 5).fill(0xff)
    backing.set(bytes, 3)
    const view = backing.subarray(3, length + 3)
    expect(view.byteOffset).toBe(3)
    expect(view.length).toBe(length)
    expect(digestSync(view)).toBe(expected)
    expect(runDigest(view)).toBe(expected)
    expect(runSynchronousService(view)).toBe(expected)
  })

  it.each(pinnedVectors)("matches the pinned digest of $label", ({ hex, text }) => {
    const bytes = new TextEncoder().encode(text)
    expect(nodeDigest(bytes)).toBe(hex)
    expect(digestSync(text)).toBe(hex)
    expect(digestSync(bytes)).toBe(hex)
    expect(runDigest(text)).toBe(hex)
    expect(runSynchronousService(text)).toBe(hex)
  })
})
