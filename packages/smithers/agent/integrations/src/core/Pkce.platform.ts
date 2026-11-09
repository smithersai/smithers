/**
 * Host cryptography operations used by the PKCE helpers.
 *
 * @since 0.1.0
 */

import { Effect } from "effect"

/** @private
 * @since 0.1.0
 */
export const DEFAULT_RANDOM_BYTES = 32
const MIN_RANDOM_BYTES = 32
const MAX_RANDOM_BYTES = 96
const base64UrlNoPadding = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
const checkByteLength = (byteLength: number): Effect.Effect<void, TypeError | RangeError> =>
  Effect.suspend(() => {
    if (!Number.isInteger(byteLength)) {
      return Effect.fail(new TypeError("PKCE code_verifier byteLength must be an integer"))
    }
    if (byteLength < MIN_RANDOM_BYTES || byteLength > MAX_RANDOM_BYTES) {
      return Effect.fail(new RangeError("PKCE code_verifier byteLength must be 32..96 bytes"))
    }
    return Effect.void
  })
// A checked verifier is ASCII, so its UTF-8 bytes are its ASCII bytes.
/** @private
 * @since 0.1.0
 */
export const challengeOf = (codeVerifier: string): Effect.Effect<string> =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))).pipe(
    Effect.map((digest) => base64UrlNoPadding(new Uint8Array(digest)))
  )
/**
 * A high-entropy `code_verifier`.
 *
 * `byteLength` is the entropy drawn, not the string length: 32 bytes produce
 * the 43-character minimum and 96 bytes the 128-character maximum RFC 7636
 * allows. Anything outside 32..96 bytes would encode outside that range.
 *
 * @category constructors
 * @since 1.0.0
 */
export const createCodeVerifier = (
  byteLength: number = DEFAULT_RANDOM_BYTES
): Effect.Effect<string, TypeError | RangeError> =>
  Effect.andThen(
    checkByteLength(byteLength),
    Effect.sync(() => base64UrlNoPadding(crypto.getRandomValues(new Uint8Array(byteLength))))
  )
