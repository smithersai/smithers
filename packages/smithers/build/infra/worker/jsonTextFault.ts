/**
 * Finds information `JSON.parse` would silently discard from JSON text.
 *
 * @since 0.1.0
 */

const numberLexeme = /[0-9eE+.-]/

/**
 * What the raw text carried that the parsed value lost.
 *
 * `duplicate-member` is an object that names one member twice, after escape
 * decoding; `JSON.parse` keeps only the last value. `lossy-number` is a number
 * literal that does not round-trip through an IEEE-754 double.
 *
 * @category models
 * @since 0.1.0
 */
export type JsonTextFault = "duplicate-member" | "lossy-number"

/**
 * Scans text `JSON.parse` already accepted and reports the first fault.
 *
 * Each object keeps its own member-name set, so equal names in separate
 * objects never collide, and escaped names are decoded before comparison.
 * The scan assumes well-formed JSON and is linear in the text length, which
 * every caller has already bounded. Numbers are checked only when `numbers`
 * is set.
 *
 * @category validation
 * @since 0.1.0
 */
export const jsonTextFault = (text: string, options: { readonly numbers: boolean }): JsonTextFault | null => {
  const scopes: Array<Set<string> | null> = []
  // The member names of the object whose key comes next, or `null` when the
  // next string is a value.
  let keyScope: Set<string> | null = null
  let index = 0
  while (index < text.length) {
    const character = text.charAt(index)
    if (character === "{") {
      keyScope = new Set<string>()
      scopes.push(keyScope)
      index += 1
    } else if (character === "[") {
      scopes.push(null)
      keyScope = null
      index += 1
    } else if (character === "}" || character === "]") {
      scopes.pop()
      keyScope = null
      index += 1
    } else if (character === ",") {
      const enclosing = scopes.at(-1)
      keyScope = enclosing instanceof Set ? enclosing : null
      index += 1
    } else if (character === ":") {
      keyScope = null
      index += 1
    } else if (character === "\"") {
      let end = index + 1
      while (end < text.length && text.charAt(end) !== "\"") end += text.charAt(end) === "\\" ? 2 : 1
      if (keyScope !== null) {
        // The caller already parsed this text, so every string token in it
        // parses on its own.
        const name = JSON.parse(text.slice(index, end + 1)) as string
        if (keyScope.has(name)) return "duplicate-member"
        keyScope.add(name)
      }
      index = end + 1
    } else if (options.numbers && (character === "-" || (character >= "0" && character <= "9"))) {
      let end = index + 1
      while (end < text.length && numberLexeme.test(text.charAt(end))) end += 1
      const lexeme = text.slice(index, end)
      const value = Number(lexeme)
      if (!Number.isFinite(value) || Object.is(value, -0) || String(value) !== lexeme) return "lossy-number"
      index = end
    } else index += 1
  }
  return null
}
