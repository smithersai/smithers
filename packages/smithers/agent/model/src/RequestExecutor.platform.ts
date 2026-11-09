/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 0.1.0
 */

/**
 * Decodes UTF-8 with a non-fatal decoder, which answers replacement characters
 * rather than throwing.
 *
 * @private
 * @since 0.1.0
 * @throws {never}
 */
export const decodeText = (
  decoder: TextDecoder,
  bytes?: Uint8Array,
  options?: { readonly stream?: boolean }
): string => decoder.decode(bytes, options)

/**
 * Decodes one complete body as UTF-8 with a non-fatal decoder.
 *
 * @private
 * @since 0.1.0
 * @throws {never}
 */
export const decodeBody = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
