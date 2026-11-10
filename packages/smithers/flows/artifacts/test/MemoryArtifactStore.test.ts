import * as Hex from "effect/encoding/Hex"
/**
 * The memory and no-op stores: the browser/test tier, and the honest refusal
 * a composition gets when it has no artifact store at all.
 */
import { describe, expect, it } from "@effect/vitest"
import { syncCrypto } from "@smthrs/crypto"
import * as EffectDigest from "effect/crypto/Digest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as PlatformError from "effect/PlatformError"
import * as ArtifactStore from "../src/ArtifactStore.vibe"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"

const artifact = "an in-memory artifact"
const digest = sha256(bytes(artifact))

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown }).error
}

describe("makeMemory", () => {
  it.effect("round-trips bytes under their own digest", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeMemory()
      expect(yield* withCrypto(artifacts.put(bytes(artifact)))).toBe(digest)
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
      expect(yield* withCrypto(artifacts.has(digest))).toBe(true)
    }))

  it.effect("is immune to a caller mutating the array it put", () =>
    Effect.gen(function*() {
      // The map is keyed by the digest measured at accept time, so an aliased
      // input array would let a later caller mutation corrupt the stored
      // content for its address. `put` stores a defensive copy instead.
      const artifacts = ArtifactStore.makeMemory()
      const input = bytes(artifact)
      const stored = yield* withCrypto(artifacts.put(input))
      input[0] = 0x58
      expect(text(yield* withCrypto(artifacts.get(stored)))).toBe(artifact)
    }))

  it.effect("snapshots input before an asynchronous Crypto host yields", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const crypto = EffectDigest.Digest.of({
        digest: (algorithm, snapshot) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(syncCrypto.digest(algorithm, snapshot))
          ),
        digestHex(algorithm, data) {
          return Effect.map(this.digest(algorithm, data), Hex.encode)
        }
      })
      const artifacts = ArtifactStore.makeMemory()
      const input = bytes(artifact)
      const running = yield* artifacts.put(input).pipe(
        Effect.provideService(EffectDigest.Digest, crypto),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      input.fill(0)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(running)).toBe(digest)
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))

  it.effect("maps failing, throwing, and malformed Crypto hosts to input-safe typed errors", () =>
    Effect.gen(function*() {
      const failure = PlatformError.systemError({
        _tag: "Unknown",
        module: "test",
        method: "digest"
      })
      const hosts = [
        EffectDigest.Digest.of({
          digest: () => Effect.die(failure),
          digestHex(algorithm, data) {
            return Effect.map(this.digest(algorithm, data), Hex.encode)
          }
        }),
        EffectDigest.Digest.of({
          digest: () => {
            throw new Error("host digest throw")
          },
          digestHex(algorithm, data) {
            return Effect.map(this.digest(algorithm, data), Hex.encode)
          }
        }),
        EffectDigest.Digest.of({
          digest: () => Effect.succeed(new Uint8Array(1)),
          digestHex(algorithm, data) {
            return Effect.map(this.digest(algorithm, data), Hex.encode)
          }
        })
      ]
      const secret = "artifact-bytes-that-must-not-enter-errors"
      for (const crypto of hosts) {
        const exit = yield* ArtifactStore.makeMemory().put(bytes(secret)).pipe(
          Effect.provideService(EffectDigest.Digest, crypto),
          Effect.exit
        )
        const error = errorOf(exit) as ArtifactStore.ArtifactStoreError
        expect(error.code).toBe("digest_failed")
        expect(error.message).not.toContain(secret)
        expect(JSON.stringify(error)).not.toContain(secret)
      }
    }))

  it.effect("reports an input buffer detached before execution as a host refusal", () =>
    Effect.gen(function*() {
      // The snapshot is the first statement of every `put`, before the Crypto
      // service is consulted at all, so a refused copy is a host allocation
      // failure and must not be reported as a crypto one.
      const input = bytes(artifact)
      structuredClone(input.buffer, { transfer: [input.buffer as ArrayBuffer] })
      const exit = yield* withCrypto(ArtifactStore.makeMemory().put(input).pipe(Effect.exit))
      expect(errorOf(exit)).toMatchObject({
        code: "unavailable",
        message: "the host could not copy the artifact bytes"
      })
    }))

  it.effect("round-trips a zero-byte artifact", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeMemory()
      const empty = yield* withCrypto(artifacts.put(new Uint8Array(0)))
      expect(empty).toBe(sha256(new Uint8Array(0)))
      expect(yield* withCrypto(artifacts.has(empty))).toBe(true)
      expect((yield* withCrypto(artifacts.get(empty))).byteLength).toBe(0)
    }))

  it.effect("is immune to a caller mutating the array it got", () =>
    Effect.gen(function*() {
      // `get` hands out a copy for the same reason: the stored array must never
      // be reachable through a reference a caller can still write to.
      const artifacts = ArtifactStore.makeMemory()
      yield* withCrypto(artifacts.put(bytes(artifact)))
      const first = yield* withCrypto(artifacts.get(digest))
      first[0] = 0x58
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))

  it.effect("reports a typed miss for an address it never accepted", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeMemory()
      const exit = yield* withCrypto(artifacts.get(digest).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactMissing)._tag).toBe("@smthrs/artifacts/ArtifactMissing")
      expect(yield* withCrypto(artifacts.has(digest))).toBe(false)
    }))

  it.effect("refuses an address that is not usable as one", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(ArtifactStore.makeMemory().get("").pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("invalid_digest")
    }))

  it.effect("returns a deduplicated subset from findMissing", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeMemory()
      yield* withCrypto(artifacts.put(bytes(artifact)))
      const absent = sha256(bytes("never stored"))
      expect(yield* withCrypto(artifacts.findMissing([digest, absent, absent]))).toEqual([absent])
    }))

  it.effect("layerMemory provides it under the tag", () =>
    Effect.gen(function*() {
      const published = yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (artifacts) => artifacts.put(bytes(artifact))).pipe(
          Effect.provide(ArtifactStore.layerMemory)
        )
      )
      expect(published).toBe(digest)
    }))
})

describe("makeNoop", () => {
  it.effect("fails every operation as unavailable", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeNoop()
      const exits: Array<Exit.Exit<unknown, unknown>> = [
        yield* withCrypto(artifacts.put(bytes(artifact)).pipe(Effect.exit)),
        yield* withCrypto(artifacts.get(digest).pipe(Effect.exit)),
        yield* withCrypto(artifacts.has(digest).pipe(Effect.exit)),
        yield* withCrypto(artifacts.findMissing([digest]).pipe(Effect.exit))
      ]
      for (const exit of exits) {
        expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("unavailable")
      }
    }))

  it.effect("takes per-method overrides", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeNoop({ has: () => Effect.succeed(true) })
      expect(yield* withCrypto(artifacts.has(digest))).toBe(true)
    }))

  it.effect("layerNoop provides it under the tag", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (artifacts) => artifacts.has(digest)).pipe(
          Effect.provide(ArtifactStore.layerNoop()),
          Effect.exit
        )
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("unavailable")
    }))
})
