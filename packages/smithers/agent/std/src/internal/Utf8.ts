/**
 * Lenient UTF-8 decoding. A decoder without `fatal` replaces malformed input
 * instead of rejecting it, so these calls have no failure to report.
 *
 * @since 1.0.0
 */

const lenient = new TextDecoder()

/**
 * Decodes whole bytes, replacing malformed sequences.
 *
 * @private
 * @throws {never}
 * @since 1.0.0
 */
export const decodeUtf8 = (bytes: Uint8Array): string => lenient.decode(bytes)

/**
 * Feeds one chunk to a non-fatal streaming decoder, or flushes it when `bytes`
 * is absent.
 *
 * @private
 * @throws {never}
 * @since 1.0.0
 */
export const decodeChunk = (decoder: TextDecoder, bytes?: Uint8Array): string =>
  bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true })
