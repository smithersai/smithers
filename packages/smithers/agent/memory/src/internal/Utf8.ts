/**
 * UTF-8 byte-budget truncation.
 *
 * @since 0.1.0
 */

const encoder = new TextEncoder()

/**
 * Truncates text to complete Unicode code points within a UTF-8 byte limit.
 *
 * @category encoding
 * @since 0.1.0
 */
export const truncateBytes = (text: string, maxBytes: number): string => {
  if (encoder.encode(text).byteLength <= maxBytes) return text
  const characters = [...text]
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encoder.encode(characters.slice(0, middle).join("")).byteLength <= maxBytes) low = middle
    else high = middle - 1
  }
  return characters.slice(0, low).join("")
}
