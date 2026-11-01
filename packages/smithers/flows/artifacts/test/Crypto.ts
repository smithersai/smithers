import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto, Sha256 } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const encoder = new TextEncoder()

/** Hashes test fixtures with the concrete Node crypto layer. */
export const sha256 = (input: string | Uint8Array): typeof Sha256.Digest.Type =>
  Effect.runSync(
    Schema.decodeUnknownEffect(Sha256)(input).pipe(
      Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest)),
      Effect.orDie
    )
  )

/** Provides concrete Node cryptography to a test Effect. */
export const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
  Effect.provide(effect, Crypto.layerFromDigest(NodeCrypto.layerDigest))

/** UTF-8 bytes, the shape every artifact fixture is written in. */
export const bytes = (text: string): Uint8Array => encoder.encode(text)

/** Decodes stored artifact bytes back to text for assertions. */
export const text = (input: Uint8Array | undefined): string | undefined =>
  input === undefined ? undefined : new TextDecoder().decode(input)
