import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Sha256 } from "@smthrs/crypto"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const encoder = new TextEncoder()

/** Hashes test fixtures with the concrete Node crypto layer. */
export const sha256 = (input: string | Uint8Array): typeof Sha256.Digest.Type =>
  Effect.runSync(
    Schema.decodeUnknownEffect(Sha256)(input).pipe(Effect.provide(NodeCrypto.layer), Effect.orDie)
  )

/** Provides concrete Node cryptography to a test Effect. */
export const withCrypto = <A, E>(effect: Effect.Effect<A, E, EffectDigest.Digest>): Effect.Effect<A, E> =>
  Effect.provide(effect, NodeCrypto.layer)

/** UTF-8 bytes, the shape every artifact fixture is written in. */
export const bytes = (text: string): Uint8Array => encoder.encode(text)

/** Decodes stored artifact bytes back to text for assertions. */
export const text = (input: Uint8Array | undefined): string | undefined =>
  input === undefined ? undefined : new TextDecoder().decode(input)
