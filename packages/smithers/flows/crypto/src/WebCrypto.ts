/**
 * Effect's `Crypto` service over the global WebCrypto object.
 *
 * Node, Bun, browsers and Cloudflare Workers all expose WebCrypto as
 * `globalThis.crypto`. It is a web-standard global, not platform code, so this
 * one implementation serves every host that composes the durable engine.
 *
 * Randomness is read only when a caller asks for it, never while a module
 * evaluates: Cloudflare refuses to deploy a script that calls
 * `crypto.getRandomValues` at module scope (upload error 10021).
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Crypto from "./Crypto.vibe"

/**
 * The most bytes one `crypto.getRandomValues` call may fill, per the Web
 * Crypto specification. A larger call throws `QuotaExceededError`, so larger
 * requests are filled in chunks.
 */
const randomValuesLimit = 65_536

/**
 * Builds Effect's `Crypto` over the global WebCrypto object.
 *
 * `randomBytes` fills any size, at most 65,536 bytes per
 * `crypto.getRandomValues` call. `digest` copies its input and calls
 * `crypto.subtle.digest`; a rejection fails with a `PlatformError` whose
 * reason is `Unknown`, module `Crypto`, method `digest`, and whose cause is
 * WebCrypto's own error.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (): Crypto.Crypto =>
  Crypto.make({
    randomBytes: (size) => {
      const bytes = new Uint8Array(size)
      for (let offset = 0; offset < size; offset += randomValuesLimit) {
        globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + randomValuesLimit, size)))
      }
      return bytes
    },
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: () => globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data)),
        catch: (cause) =>
          PlatformError.systemError({
            _tag: "Unknown",
            module: "Crypto",
            method: "digest",
            description: `WebCrypto could not compute ${algorithm}`,
            cause
          })
      }).pipe(Effect.map((digest) => new Uint8Array(digest)))
  })

/**
 * Provides Effect's `Crypto` over the global WebCrypto object: {@link make}
 * as a layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<Crypto.Crypto> = Layer.succeed(Crypto.Crypto)(make())
