/**
 * Constant-time HMAC-SHA256 webhook verification.
 *
 * A webhook signature is attacker-supplied, so the digest comparison must not
 * return early on the first differing byte: an early return turns the endpoint
 * into an oracle that leaks the expected digest one byte at a time.
 * {@link constantTimeEqual} therefore always scans the longer of the two
 * inputs and folds the length difference into the result, and it is the only
 * comparison {@link verifySignature} performs on digest material.
 *
 * The header formats every provider in this package uses are accepted:
 * GitHub's `sha256=<hex>` in `X-Hub-Signature-256`, bare hex digests,
 * and standard-base64 digests.
 *
 * The HMAC is WebCrypto's (`crypto.subtle`), which a browser, a Cloudflare
 * Worker, Node and Bun all provide, so computing and verifying are Effects.
 * A host without WebCrypto (an insecure browser context) is a defect, not a
 * refusal: every delivery would otherwise fail quietly.
 *
 * @since 1.0.0
 */

import { Effect } from "effect"

const HEX = /^[0-9a-f]+$/i
// Standard base64, supported alongside hex digests.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * The prefix GitHub puts in front of its hex digest.
 *
 * @category constants
 * @since 1.0.0
 */
export const GITHUB_SIGNATURE_PREFIX = "sha256="

/**
 * Compares two byte strings without returning early on a mismatch.
 *
 * The loop always examines the longer input, and the length difference is
 * folded into the accumulator, so neither the position of the first differing
 * byte nor a length mismatch changes how much work the comparison does.
 *
 * @category verification
 * @since 1.0.0
 */
export const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

const encoder = new TextEncoder()

// HMAC zero-pads a key shorter than the hash block, so the empty key and one
// zero byte are the same key. WebCrypto refuses a zero-length raw key.
const keyBytes = (secret: string): Uint8Array<ArrayBuffer> => {
  const bytes = encoder.encode(secret)
  return bytes.length === 0 ? new Uint8Array(1) : bytes
}

// Text is UTF-8, as the provider signed it; bytes are copied when the Effect
// starts, so the caller's array is not read again after that.
const hmacSha256 = (payload: string | Uint8Array, secret: string): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const data = typeof payload === "string" ? encoder.encode(payload) : new Uint8Array(payload)
    const key = await crypto.subtle.importKey("raw", keyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign"
    ])
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data))
  })

const encodeHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * The lowercase hex HMAC-SHA256 of `payload` under `secret`.
 *
 * @category verification
 * @since 1.0.0
 */
export const computeHmacSha256Hex = (payload: string | Uint8Array, secret: string): Effect.Effect<string> =>
  Effect.map(hmacSha256(payload, secret), encodeHex)

/**
 * What {@link verifySignature} needs to check one delivery.
 *
 * @category models
 * @since 1.0.0
 */
export interface VerifyOptions {
  /** The exact bytes the provider signed. Never the re-serialized JSON. */
  readonly payload: string | Uint8Array
  readonly secret: string
  readonly signature: string | null | undefined
  /**
   * A required prefix on the supplied signature, stripped before decoding.
   * Omit it to strip an optional `sha256=` and otherwise accept a bare digest.
   */
  readonly prefix?: string | undefined
}

// Called only on an even-length string `HEX` accepts.
const decodeHex = (value: string): Uint8Array =>
  Uint8Array.from(
    { length: value.length / 2 },
    (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  )

// `atob` refuses what does not decode, such as a length one past a whole
// quantum or padding that does not end one; a refusal is a mismatch.
const decodeBase64 = (value: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  } catch {
    return undefined
  }
}

/**
 * Whether `options.signature` is a valid HMAC-SHA256 of `options.payload`.
 *
 * Succeeds with `false`, and never fails, for a missing signature, an empty
 * secret, a wrong prefix, an undecodable digest, and a digest that does not
 * match. It reads `options` when it runs.
 *
 * @category verification
 * @since 1.0.0
 */
export const verifySignature = (options: VerifyOptions): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    const { payload, prefix, secret, signature } = options
    if (typeof signature !== "string" || signature.length === 0 || !secret) return Effect.succeed(false)
    let provided = signature.trim()
    if (prefix !== undefined) {
      if (!provided.toLowerCase().startsWith(prefix.toLowerCase())) return Effect.succeed(false)
      provided = provided.slice(prefix.length)
    } else if (provided.toLowerCase().startsWith(GITHUB_SIGNATURE_PREFIX)) {
      provided = provided.slice(GITHUB_SIGNATURE_PREFIX.length)
    }
    if (provided.length === 0) return Effect.succeed(false)
    return Effect.map(hmacSha256(payload, secret), (expected) => {
      if (provided.length === expected.length * 2 && HEX.test(provided)) {
        if (constantTimeEqual(expected, decodeHex(provided))) return true
      }
      if (BASE64.test(provided)) {
        const decoded = decodeBase64(provided)
        if (decoded !== undefined && constantTimeEqual(expected, decoded)) return true
      }
      return false
    })
  })
