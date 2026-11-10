/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

/**
 * The SHA-256 digest of `key`'s UTF-8 bytes, from the platform's Web Crypto.
 *
 * @private
 * @since 1.0.0
 */
export const sha256 = (key: string): Promise<ArrayBuffer> =>
  globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
