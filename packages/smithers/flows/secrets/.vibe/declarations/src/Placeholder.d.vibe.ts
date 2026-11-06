/**
 * Placeholders: the text a guest holds where a secret's value would be.
 *
 * A placeholder is `smthrs-secret-` and 64 lowercase hexadecimal characters.
 * It is worthless anywhere but the egress that knows it: only there does it
 * turn into its secret's value, and only for that secret's own hosts. A guest
 * that prints, logs or sends it elsewhere gives away nothing.
 *
 * {@link minter} derives placeholders with HMAC-SHA-256 under a key the host
 * holds, from a scope and a secret's name. The scope names what the guest is,
 * such as a repository, a branch and a sandbox generation, so a new
 * generation gets new placeholders and the old ones stop working, and the
 * host needs to store nothing to recognize them: it derives them again.
 *
 * @since 0.1.0
 */
export { KeyTooShort, minimumKeyLength, minter, prefix } from "../../../src/Placeholder.vibe.platform.js";
export type { Minter } from "../../../src/Placeholder.vibe.platform.js";
/**
 * Whether `text` is exactly one placeholder.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const is: (text: string) => boolean;
/**
 * Every placeholder in `text`, in order, repeats included.
 *
 * @category parsing
 * @since 0.1.0
 */
export declare const find: (text: string) => ReadonlyArray<string>;
