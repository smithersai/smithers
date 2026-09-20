import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"

/** Provides concrete Node cryptography to a test Effect. */
export const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
  Effect.provide(effect, NodeCrypto.layer)

/** Provides the same cryptography to an Effect expected to fail, yielding its typed error. */
export const withCryptoFailure = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<E, A> =>
  withCrypto(Effect.flip(effect))
