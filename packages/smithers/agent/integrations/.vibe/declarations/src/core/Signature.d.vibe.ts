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
import { Effect } from "effect";
/**
 * The prefix GitHub puts in front of its hex digest.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const GITHUB_SIGNATURE_PREFIX = "sha256=";
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
export declare const constantTimeEqual: (left: Uint8Array, right: Uint8Array) => boolean;
/**
 * The lowercase hex HMAC-SHA256 of `payload` under `secret`.
 *
 * @category verification
 * @since 1.0.0
 */
export declare const computeHmacSha256Hex: (payload: string | Uint8Array, secret: string) => Effect.Effect<string>;
/**
 * What {@link verifySignature} needs to check one delivery.
 *
 * @category models
 * @since 1.0.0
 */
export interface VerifyOptions {
    /** The exact bytes the provider signed. Never the re-serialized JSON. */
    readonly payload: string | Uint8Array;
    readonly secret: string;
    readonly signature: string | null | undefined;
    /**
     * A required prefix on the supplied signature, stripped before decoding.
     * Omit it to strip an optional `sha256=` and otherwise accept a bare digest.
     */
    readonly prefix?: string | undefined;
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
export declare const verifySignature: (options: VerifyOptions) => Effect.Effect<boolean>;
