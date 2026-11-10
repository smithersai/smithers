// Deep reviewed and polished by a human on 2026-08-31.

/**
 * Canonical flow-key derivation and stored-key validation.
 *
 * Deriving a key and parsing one from storage are deliberately separate
 * operations. {@link deriveKey} canonicalizes structured input and hashes it;
 * {@link StoredKey} validates an already-derived wire value without changing
 * it. {@link DerivedKey} provides the derivation as a schema transformation.
 *
 * This module is the `@smthrs/keys/Key` subpath: it names every public concept
 * the package has, each defined in its own file.
 *
 * @since 0.1.0
 */

export * from "./DerivedKey.vibe"
export * from "./deriveKey.vibe"
export * from "./digest.ts"
export * from "./KeyDerivationError.vibe"
export * from "./KeyV1.vibe"
export * from "./StoredKey.ts"
