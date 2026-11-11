/**
 * The platform code of `Docs.vibe`: decoding a fetched body, which a .vibe file
 * does not do directly (EK4402).
 *
 * @since 0.1.0
 * @private
 */

/**
 * The body as UTF-8 text, or `undefined` when it is not well-formed UTF-8.
 *
 * @throws {never}
 * @since 0.1.0
 * @private
 */
export const decodeUtf8 = (body: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body)
  } catch {
    return undefined
  }
}
