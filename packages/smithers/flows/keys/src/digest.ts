// Deep reviewed and polished by a human on 2026-08-31.

/**
 * The SHA-256 payload carried by a stored key.
 *
 * @since 0.1.0
 */

import type { Digest as Sha256Digest } from "@smthrs/crypto"
import type { StoredKey } from "./StoredKey.ts"

/**
 * Returns the validated SHA-256 payload of a stored key.
 *
 * Keeping prefix knowledge here prevents consumers from guessing at the wire
 * format with `slice` or delimiter searches.
 *
 * This accessor trusts the stored-key brand and performs no runtime validation.
 * Validate received strings with `StoredKey` before calling it.
 *
 * @param key - A previously validated stored key.
 * @returns The 64-character lowercase hexadecimal SHA-256 payload.
 * @category accessors
 * @since 1.0.0
 * @throws {never}
 */
export const digest = (key: StoredKey): Sha256Digest => key.slice("key1_".length) as Sha256Digest
