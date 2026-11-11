/**
 * The fingerprint digest dependency, injectable for failure-path tests.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"

/**
 * Hashes the canonical journal content with SHA-256.
 *
 * @category internal
 * @since 1.0.0
 */
export const digest = (bytes: Uint8Array<ArrayBuffer>): Effect.Effect<ArrayBuffer, unknown> =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", bytes),
    catch: (cause) => cause
  })

/**
 * Defaults to the real digest; a faulty service can refuse a fingerprint.
 *
 * @category internal
 * @since 1.0.0
 */
export const JournalDigest = Context.Reference<{ readonly digest: typeof digest }>("@smthrs/journal/JournalDigest", {
  defaultValue: () => ({ digest })
})
