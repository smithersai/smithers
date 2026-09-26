/**
 * Content digests shared by the roster, skill pack, and prompt modules.
 *
 * Every identity this package pins (a roster revision, a skill revision, a
 * prompt digest) is a lowercase SHA-256 over either UTF-8 text or the RFC 8785
 * canonical JSON of a plain value, so two hosts that read the same files agree
 * on the same bytes.
 *
 * @since 1.0.0
 */
import { canonicalize } from "@smthrs/canonical/Serializer"
import { createHash } from "node:crypto"

/**
 * Lowercase hexadecimal SHA-256 of UTF-8 text.
 *
 * @private
 * @since 1.0.0
 */
export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/**
 * Lowercase hexadecimal SHA-256 of a value's RFC 8785 canonical JSON.
 *
 * @private
 * @since 1.0.0
 */
export const canonicalDigest = (value: unknown): string => sha256Hex(canonicalize(value))

/**
 * The UTF-8 byte length of text.
 *
 * @private
 * @since 1.0.0
 */
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8")
