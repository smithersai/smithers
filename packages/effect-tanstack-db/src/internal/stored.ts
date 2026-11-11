/**
 * How TanStack DB's SQLite persistence stores a row: its key as text and its
 * value as JSON, with the values JSON can't hold tagged. A migration reads and
 * writes rows in place, so it reads and writes them exactly as the persistence
 * does (`@tanstack/db-sqlite-persistence-core` 0.4.11,
 * `encodePersistedJsonValue`, `decodePersistedJsonValue` and
 * `encodePersistedStorageKey`). The migration suites prove the round trip
 * against the persistence itself.
 *
 * @since 0.3.0
 */

const TYPE = "__tanstack_db_persisted_type__"
const VALUE = "value"

const tagged = (type: string, value: string) => ({ [TYPE]: type, [VALUE]: value })

const isTagged = (value: object): value is { readonly [TYPE]: string; readonly [VALUE]: string } => {
  const record = value as Record<string, unknown>
  return typeof record[TYPE] === "string" && typeof record[VALUE] === "string"
}

const encodeValue = (value: unknown): unknown => {
  if (value === undefined || value === null) return value
  if (typeof value === "bigint") return tagged("bigint", value.toString())
  if (value instanceof Date) return tagged("date", value.toISOString())
  if (typeof value === "number") {
    if (Number.isNaN(value)) return tagged("nan", "NaN")
    if (value === Number.POSITIVE_INFINITY) return tagged("infinity", "Infinity")
    if (value === Number.NEGATIVE_INFINITY) return tagged("-infinity", "-Infinity")
    return value
  }
  if (Array.isArray(value)) return value.map(encodeValue)
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const encoded: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      const next = encodeValue(entry)
      if (next !== undefined) {
        Object.defineProperty(encoded, key, { value: next, enumerable: true, writable: true, configurable: true })
      }
    }
    // The persistence escapes a row's own field named as its tag.
    if (typeof record[TYPE] === "string") encoded[TYPE] = tagged("string", record[TYPE])
    return encoded
  }
  return value
}

const decodeValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(decodeValue)
  if (isTagged(value)) {
    switch (value[TYPE]) {
      case "string":
        return value[VALUE]
      case "bigint":
        return BigInt(value[VALUE])
      case "date": {
        const date = new Date(value[VALUE])
        return Number.isNaN(date.getTime()) ? null : date
      }
      case "nan":
        return Number.NaN
      case "infinity":
        return Number.POSITIVE_INFINITY
      case "-infinity":
        return Number.NEGATIVE_INFINITY
    }
    // A tag this build can't write back as it was, such as a Temporal value: the row isn't migrated, but kept.
    throw new Error(`unreadable stored value: ${value[TYPE]}`)
  }
  const decoded: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(decoded, key, {
      value: decodeValue(entry),
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  return decoded
}

/**
 * The row the persistence stored as `text`. A value tagged with a type this
 * build doesn't read throws, as malformed JSON does.
 *
 * @category stored rows
 * @since 0.3.0
 */
export const decodeStored = (text: string): unknown => decodeValue(JSON.parse(text))

/**
 * `row` as the persistence stores it.
 *
 * @category stored rows
 * @since 0.3.0
 */
export const encodeStored = (row: unknown): string => JSON.stringify(encodeValue(row))

/**
 * A key as the persistence stores it: `s:` and the text, or `n:` and the
 * number. The persistence writes `-0` as `n:-0`; a row's JSON can't hold
 * `-0`, so a key read from one never is, and a migration that answers `-0`
 * changes the row's key.
 *
 * @category stored rows
 * @since 0.3.0
 */
export const encodeKey = (key: string | number): string => (typeof key === "number" ? `n:${key}` : `s:${key}`)

/**
 * An SQL identifier, quoted: a collection's table name as the persistence
 * registered it.
 *
 * @category stored rows
 * @since 0.3.0
 * @throws {never}
 */
export const quote = (identifier: string): string => `"${identifier.replaceAll("\"", "\"\"")}"`
