/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

/**
 * A fresh random request id: 16 bytes as lowercase hex.
 *
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const makeRequestId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
