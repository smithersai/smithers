/**
 * Small readers for values that come out of YAML and JSON files.
 *
 * @since 0.1.0
 */

/**
 * True for a plain mapping.
 *
 * @category guards
 * @since 0.1.0
 * @throws {never}
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The text of a scalar, as a workflow runner would print it. A null is empty;
 * lists and mappings have no scalar text.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const asScalar = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return value === null ? "" : undefined
}

/**
 * The strings of a value that is one string or a list of strings. Anything
 * else is `undefined`.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const asStrings = (value: unknown): ReadonlyArray<string> | undefined => {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return undefined
  const items: ReadonlyArray<unknown> = value
  return items.every((item) => typeof item === "string") ? items : undefined
}

/**
 * Quotes one word for a POSIX shell. A word with nothing special stays bare.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const shellQuote = (word: string): string =>
  /^[\w@%+=:,./#-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
