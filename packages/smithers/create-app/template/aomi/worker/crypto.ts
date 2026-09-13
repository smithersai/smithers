/**
 * The `effect/Crypto` service over workerd's WebCrypto.
 *
 * `AgentAction.layer` and `Flow.execute` both require `Crypto.Crypto`: the
 * digests that key a sealed step and the ids a flow execution is named by come
 * from it, so the composition never reaches `globalThis.crypto` itself. effect
 * 4.0.0-rc.115 ships `Crypto.make` plus platform layers for Node and Bun; it
 * ships none for a Worker, and `@effect/platform-browser` is not a dependency
 * here. `Crypto.make` takes exactly the two primitives workerd already has, so
 * this is the whole adapter.
 *
 * `crypto.getRandomValues` and `crypto.subtle` are both available in workerd
 * without a compatibility flag.
 */
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"

const failure = (method: string, cause: unknown): PlatformError.PlatformError =>
  new PlatformError.PlatformError(
    new PlatformError.BadArgument({
      module: "worker/crypto",
      method,
      description: cause instanceof Error ? cause.message : String(cause),
      cause
    })
  )

/**
 * The WebCrypto-backed service.
 *
 * `randomBytes` returns a fresh array on every call: `Crypto.make` formats
 * UUIDs by mutating the bytes it is handed, so a shared buffer would hand the
 * same id out twice.
 */
export const crypto: Crypto.Crypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () => globalThis.crypto.subtle.digest(algorithm, data as BufferSource),
      catch: (cause) => failure("digest", cause)
    }).pipe(Effect.map((buffer) => new Uint8Array(buffer)))
})

/** Provides {@link crypto} as `Crypto.Crypto`. */
export const layerCrypto: Layer.Layer<Crypto.Crypto> = Layer.succeed(Crypto.Crypto)(crypto)
