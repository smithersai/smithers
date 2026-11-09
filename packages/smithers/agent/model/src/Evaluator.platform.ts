/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0-rc.0
 */

/**
 * Decodes UTF-8 with a non-fatal decoder, which answers replacement characters
 * rather than throwing.
 *
 * @private
 * @since 1.0.0-rc.0
 * @throws {never}
 */
export const decodeText = (
  decoder: TextDecoder,
  bytes?: Uint8Array,
  options?: { readonly stream?: boolean }
): string => decoder.decode(bytes, options)
