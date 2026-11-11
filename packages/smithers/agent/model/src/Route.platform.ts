/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 0.1.0
 */

/**
 * Decodes a prepared request body as UTF-8 with a non-fatal decoder.
 *
 * @private
 * @since 0.1.0
 * @throws {never}
 */
export const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
