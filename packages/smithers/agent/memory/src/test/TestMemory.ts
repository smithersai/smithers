/**
 * In-memory SQLite memory layer for tests.
 *
 * This folder holds only this module so the published subpath reads
 * `@smthrs/memory/test/TestMemory`.
 *
 * @since 0.1.0
 */

import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EffectDigest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Layer from "effect/Layer"
import * as MemoryStore from "../MemoryStore.ts"

const random = Layer.sync(SecureRandom.SecureRandom)(() => {
  // A counter, not entropy: generated ids must stay distinct within one build.
  let nonce = 0
  return SecureRandom.make((size) => {
    nonce += 1
    const bytes = new Uint8Array(size)
    let remaining = nonce
    for (let index = size - 1; index >= 0 && remaining > 0; index -= 1) {
      bytes[index] = remaining % 0x100
      remaining = Math.floor(remaining / 0x100)
    }
    return bytes
  })
})

const digestBytes: typeof EffectDigest.Digest.Service["digest"] = (_algorithm, data) =>
  Effect.succeed(new Uint8Array(data))
const crypto = Layer.merge(
  random,
  Layer.succeed(EffectDigest.Digest)({
    digest: digestBytes,
    digestHex: (algorithm, data) => Effect.map(digestBytes(algorithm, data), Hex.encode)
  })
)

/**
 * Provides the authoritative memory store over a fresh in-memory database with
 * deterministic test services. Every build allocates its own database and
 * restarts its generated ids, which stay distinct within that build.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = MemoryStore.layer.pipe(Layer.provide(Layer.merge(TestDatabase.layer, crypto)))

/**
 * Provides both the authoritative memory store and its in-memory Database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWithDatabase = Layer.provideMerge(MemoryStore.layer, Layer.merge(TestDatabase.layer, crypto))
