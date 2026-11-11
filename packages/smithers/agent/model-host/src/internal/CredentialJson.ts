/**
 * Credential cuts at decoded JSON string boundaries.
 *
 * @since 1.0.0
 */

/**
 * Cuts decoded keys and string values without changing JSON formatting or
 * numeric literals. Malformed arguments retain the ordinary raw-text cut.
 *
 * @category utilities
 * @since 1.0.0
 */
export const cutCredentialJson = (text: string, cut: (value: string) => string): string => {
  try {
    JSON.parse(text)
  } catch {
    // Argument validation belongs to the tool; redaction preserves that refusal.
    return cut(text)
  }
  return cut(text.replace(/"(?:[^"\\]|\\.)*"/g, (token) => {
    const decoded = JSON.parse(token) as string
    const safe = cut(decoded)
    return safe === decoded ? token : JSON.stringify(safe)
  }))
}
