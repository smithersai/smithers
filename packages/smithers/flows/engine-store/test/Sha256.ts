import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto, Sha256 } from "@smthrs/crypto"
import { DerivedKey, type StoredKey } from "@smthrs/keys"
import { Effect, Schema } from "effect"

/** Hashes test fixtures with the concrete Node crypto layer. */
export const sha256 = (input: string | Uint8Array): string =>
  Effect.runSync(
    Schema.decodeUnknownEffect(Sha256)(input).pipe(
      Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest)),
      Effect.orDie
    )
  )

/** Provides concrete Node cryptography to a test Effect. */
export const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
  Effect.provide(effect, Crypto.layerFromDigest(NodeCrypto.layerDigest))

/** Runs a synchronous test Effect with concrete Node cryptography. */
export const runSync = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): A =>
  Effect.runSync(Effect.provide(effect, Crypto.layerFromDigest(NodeCrypto.layerDigest)))

/** Runs an asynchronous test Effect with concrete Node cryptography. */
export const runPromise = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, Crypto.layerFromDigest(NodeCrypto.layerDigest)))

/** Derives a canonical key with concrete test cryptography. */
export const key = (input: unknown): StoredKey =>
  Effect.runSync(
    Schema.decodeUnknownEffect(DerivedKey)(input).pipe(
      Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest)),
      Effect.orDie
    )
  )

/** Mirrors the engine's private invocation-key encoding. */
export const invocationKey = (input: unknown): StoredKey => key({ kind: "invocation", ...(input as object) })
