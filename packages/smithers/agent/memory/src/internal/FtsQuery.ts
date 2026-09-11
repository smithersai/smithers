/**
 * Escaping of user text into literal FTS5 queries.
 *
 * @since 0.1.0
 */
import { wellFormed } from "./Digest.ts"

/**
 * Escapes user text into quoted FTS5 terms with implicit AND semantics.
 *
 * @category queries
 * @since 0.1.0
 */
export const literalFtsQuery = (query: string): string => {
  const trimmed = wellFormed(query).replaceAll("\0", " ").trim()
  return trimmed.length === 0
    ? ""
    : trimmed
      .split(/\s+/u)
      .map((term) => `"${term.replaceAll("\"", "\"\"")}"`)
      .join(" ")
}
