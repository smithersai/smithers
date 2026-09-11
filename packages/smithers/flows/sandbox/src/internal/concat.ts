/**
 * Joins byte chunks into one buffer.
 *
 * @since 0.1.0
 */

/**
 * Copies `chunks` into one `Uint8Array`, in order, with a single allocation.
 *
 * @category utils
 * @since 0.1.0
 */
export const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const whole = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    whole.set(chunk, offset)
    offset += chunk.length
  }
  return whole
}
