import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { DerivedKey, type StoredKey } from "@smthrs/keys"
import { Effect, Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"

/** Provides concrete Node cryptography to a test Effect. */
export const withCrypto = <A, E>(
  effect: Effect.Effect<A, E, (EffectDigest.Digest | SecureRandom.SecureRandom)>
): Effect.Effect<A, E> => Effect.provide(effect, NodeCrypto.layer)

/** Runs a synchronous test Effect with concrete Node cryptography. */
export const runSync = <A, E>(effect: Effect.Effect<A, E, (EffectDigest.Digest | SecureRandom.SecureRandom)>): A =>
  Effect.runSync(Effect.provide(effect, NodeCrypto.layer))

/** Derives a canonical key with concrete test cryptography. */
export const key = (input: unknown): StoredKey =>
  runSync(Schema.decodeUnknownEffect(DerivedKey)(input).pipe(Effect.orDie))

/** Mirrors the engine's private invocation-key encoding. */
export const invocationKey = (input: unknown): StoredKey => key({ kind: "invocation", ...(input as object) })
