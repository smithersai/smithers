/**
 * The platform code of `WebPage.vibe`: the text decoder for a response's
 * charset, which a .vibe file does not create directly (EK4402).
 *
 * @since 0.1.0
 * @private
 */

/**
 * A decoder for the charset `type` names, when the platform's `TextDecoder`
 * reads it, else UTF-8.
 *
 * @throws {never}
 * @since 0.1.0
 * @private
 */
export const decoderFor = (type: string): TextDecoder => {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1]
  try {
    return new TextDecoder(charset ?? "utf-8")
  } catch {
    return new TextDecoder("utf-8")
  }
}

/**
 * The text of one more chunk of a streamed body, in the decoder's charset.
 *
 * @throws {never}
 * @since 0.1.0
 * @private
 */
export const decodeStreamed = (decoder: TextDecoder, chunk: Uint8Array): string => decoder.decode(chunk, { stream: true })
