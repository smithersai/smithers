/**
 * FNV-1a, 64 bits: a fingerprint, not a secret. Its own TypeScript module,
 * since `BigInt` is declared as a function that may throw, which it never
 * does for a character code.
 *
 * @since 0.3.0
 */

/**
 * The 64-bit FNV-1a hash of `text`, as 16 hexadecimal digits.
 *
 * @private
 * @since 0.3.0
 * @throws {never}
 */
export const fnv1a = (text: string): string => {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0")
}
