import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Cause, Effect, Exit, Layer, PlatformError } from "effect"
import * as Digest from "effect/crypto/Digest"
import { TestClock } from "effect/testing"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { Crypto } from "../src/index.ts"

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** A source that hands out the given byte runs in order, then zeros. */
const scripted = (...runs: ReadonlyArray<ReadonlyArray<number>>) => {
  const queue = runs.map((run) => Uint8Array.from(run))
  return (size: number) => {
    const next = queue.shift()
    const bytes = new Uint8Array(size)
    if (next !== undefined) bytes.set(next.subarray(0, size))
    return bytes
  }
}

const unusedDigest = () => Effect.die("digest is not under test")

const serviceOf = (randomBytes: (size: number) => Uint8Array) => Crypto.make({ randomBytes, digest: unusedDigest })

// The largest 53-bit draw, 1 - 2^-53: the draw that rounds onto an excluded endpoint.
const highest = [0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]

describe("Crypto.make", () => {
  it("fills randomBytes from the source and refuses a size that is not a non-negative safe integer", () => {
    const crypto = serviceOf((size) => new Uint8Array(size).fill(7))
    expect(Effect.runSync(crypto.randomBytes(3))).toEqual(Uint8Array.of(7, 7, 7))
    for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const error = Effect.runSync(Effect.flip(crypto.randomBytes(size)))
      expect(error).toBeInstanceOf(PlatformError.PlatformError)
      expect(error.reason._tag).toBe("BadArgument")
      expect(error.message).toContain("size must be a non-negative safe integer")
    }
  })

  it("passes digest through to the implementation", () => {
    const crypto = Crypto.make({
      randomBytes: scripted(),
      digest: (algorithm, data) => Effect.succeed(Uint8Array.of(algorithm.length, data.length))
    })
    expect(Effect.runSync(crypto.digest("SHA-256", Uint8Array.of(1, 2, 3)))).toEqual(Uint8Array.of(7, 3))
  })

  it("draws doubles in [0, 1) and booleans from 53 random bits", () => {
    expect(serviceOf(scripted()).nextDoubleUnsafe()).toBe(0)
    expect(serviceOf(scripted(highest)).nextDoubleUnsafe()).toBe(1 - 2 ** -53)
    expect(Effect.runSync(serviceOf(scripted([0x10])).random)).toBe(0.5)
    expect(Effect.runSync(serviceOf(scripted([0x10, 0, 0, 0, 0, 0, 1])).randomBoolean)).toBe(true)
    expect(Effect.runSync(serviceOf(scripted()).randomBoolean)).toBe(false)
  })

  it("draws safe integers, redrawing the one value above the safe range", () => {
    expect(serviceOf(scripted()).nextIntUnsafe()).toBe(Number.MIN_SAFE_INTEGER)
    expect(Effect.runSync(serviceOf(scripted([0x20])).randomInt)).toBe(1)
    // 0x3f… sets the sign bit with the largest magnitude, which would pass MAX_SAFE_INTEGER: drawn again.
    const crypto = serviceOf(scripted([0x3f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], [0x20, 0, 0, 0, 0, 0, 2]))
    expect(crypto.nextIntUnsafe()).toBe(3)
  })

  it("keeps randomBetween below max, even where rounding reaches it", () => {
    expect(Effect.runSync(serviceOf(scripted([0x10])).randomBetween(0, 10))).toBe(5)
    expect(Effect.runSync(serviceOf(scripted(highest)).randomBetween(1, 2))).toBe(2 - 2 ** -52)
    expect(Effect.runSync(serviceOf(scripted(highest)).randomBetween(-2, -1))).toBe(-1 - 2 ** -52)
    expect(Effect.runSync(serviceOf(scripted(highest)).randomBetween(-Number.MIN_VALUE, 0))).toBe(-Number.MIN_VALUE)
    expect(Effect.runSync(serviceOf(scripted(highest)).randomBetween(0, Number.POSITIVE_INFINITY))).toBe(
      Number.POSITIVE_INFINITY
    )
    expect(Effect.runSync(serviceOf(scripted()).randomBetween(3, 3))).toBe(3)
  })

  it("draws integers in a closed or half-open range", () => {
    expect(Effect.runSync(serviceOf(scripted(highest)).randomIntBetween(1, 3))).toBe(3)
    expect(Effect.runSync(serviceOf(scripted(highest)).randomIntBetween(1, 3, { halfOpen: true }))).toBe(2)
    expect(Effect.runSync(serviceOf(scripted()).randomIntBetween(0.5, 2.5))).toBe(1)
  })

  it("shuffles a copy of the elements", () => {
    const input = [1, 2, 3]
    expect(Effect.runSync(serviceOf(scripted()).randomShuffle(input))).toEqual([2, 3, 1])
    expect(Effect.runSync(serviceOf(scripted(highest, highest)).randomShuffle(input))).toEqual([1, 2, 3])
    expect(input).toEqual([1, 2, 3])
  })

  it("writes version 4 UUIDs as text or bytes", () => {
    const text = Effect.runSync(serviceOf((size) => new Uint8Array(size).fill(0xff)).randomUUIDv4())
    expect(text).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff")
    const bytes = Effect.runSync(serviceOf((size) => new Uint8Array(size)).randomUUIDv4({ format: "bytes" }))
    expect(hex(bytes)).toBe("00000000000040008000000000000000")
  })

  it("stamps version 7 UUIDs and ULIDs with the Clock's time", () =>
    Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(0x0123456789ab)
        const crypto = serviceOf((size) => new Uint8Array(size))
        expect(yield* crypto.randomUUIDv7()).toBe("01234567-89ab-7000-8000-000000000000")
        expect(hex(yield* crypto.randomUUIDv7({ format: "bytes" }))).toBe("0123456789ab70008000000000000000")
        expect(yield* crypto.randomULID).toBe("014D2PF2DB0000000000000000")
      }).pipe(Effect.provide(TestClock.layer()))
    ))

  it("dies when a ULID's randomness is not ten bytes", () => {
    const crypto = serviceOf(() => new Uint8Array(9))
    const exit = Effect.runSyncExit(crypto.randomULID)
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
      new Error("ULID randomness must be exactly 10 bytes, received 9")
    )
  })
})

describe("Crypto.layerFromDigest", () => {
  const layer = Crypto.layerFromDigest(NodeCrypto.layerDigest)
  const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) => Effect.runSync(Effect.provide(effect, layer))

  it.each([["SHA-1", "sha1"], ["SHA-256", "sha256"], ["SHA-384", "sha384"], ["SHA-512", "sha512"]] as const)(
    "digests %s synchronously on node:crypto",
    (algorithm, nodeName) => {
      const data = new TextEncoder().encode("the same bytes on every host")
      const digest = run(Effect.gen(function*() {
        return yield* (yield* Crypto.Crypto).digest(algorithm, data)
      }))
      expect(hex(digest)).toBe(createHash(nodeName).update(data).digest("hex"))
    }
  )

  it("refuses an algorithm outside DigestAlgorithm", () => {
    const error = run(
      Effect.flip(Effect.gen(function*() {
        return yield* (yield* Crypto.Crypto).digest("MD5" as Crypto.DigestAlgorithm, new Uint8Array(1))
      }))
    )
    expect(error.reason._tag).toBe("BadArgument")
    expect(error.message).toContain("unsupported digest algorithm MD5")
  })

  it("draws randomness from the global WebCrypto object", () => {
    const bytes = run(Effect.gen(function*() {
      return yield* (yield* Crypto.Crypto).randomBytes(32)
    }))
    expect(bytes).toHaveLength(32)
  })

  it("builds over any Digest layer", () => {
    const fixed = Layer.succeed(Digest.Digest)({
      digest: () => Effect.succeed(Uint8Array.of(1)),
      digestHex: () => Effect.succeed("01")
    })
    const digest = Effect.runSync(
      Effect.provide(
        Effect.gen(function*() {
          return yield* (yield* Crypto.Crypto).digest("SHA-1", new Uint8Array(0))
        }),
        Crypto.layerFromDigest(fixed)
      )
    )
    expect(digest).toEqual(Uint8Array.of(1))
  })
})
