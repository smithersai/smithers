/**
 * Effect cryptography for hosts with the WebCrypto reference.
 * Host layers supply digest and secure randomness independently in Effect 4.1.
 * @since 1.0.0
 */
import * as EffectDigest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Layer from "effect/Layer"

/** Constructs the standard WebCrypto digest and secure-random layers. @since 1.0.0 */
export const make = (): Layer.Layer<EffectDigest.Digest | SecureRandom.SecureRandom> =>
  Layer.mergeAll(
    EffectDigest.layerWebCrypto,
    SecureRandom.layerWebCrypto
  )

/** Provides the standard WebCrypto digest and secure-random services. @since 1.0.0 */
export const layer = make()
