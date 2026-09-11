/**
 * Deterministic text ordering and JSON canonicalization.
 *
 * @since 0.1.0
 */

/**
 * Compares text in ascending code-unit order.
 *
 * @category ordering
 * @since 0.1.0
 */
export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }
  if (typeof value !== "object" || value === null) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, member]) => [key, sortJson(member)])
  )
}

/**
 * Encodes a detached JSON value with recursively sorted object keys.
 *
 * @category encoding
 * @since 0.1.0
 */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortJson(value)) ?? ""
