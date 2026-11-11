/**
 * The value encoding of `@tanstack/offline-transactions` 1.1.3.
 * Rows use Date and Temporal markers; an object's own `__type` is escaped.
 * Kept separate from the optional executor dependency so migrations run in
 * every host. The tests compare both directions with TransactionSerializer.
 *
 * @since 0.3.0
 */

const temporalNames = [
  "Duration",
  "Instant",
  "PlainDate",
  "PlainDateTime",
  "PlainMonthDay",
  "PlainTime",
  "PlainYearMonth",
  "ZonedDateTime"
] as const

type TemporalName = typeof temporalNames[number]
interface TemporalConstructor {
  readonly from: (value: string) => unknown
  readonly prototype: { readonly toString: () => string }
}

const temporalName = (type: unknown): TemporalName | undefined =>
  typeof type === "string" && type.startsWith("Temporal.")
    ? temporalNames.find((name) => type === `Temporal.${name}`)
    : undefined

const temporalConstructor = (name: TemporalName): TemporalConstructor =>
  (globalThis as unknown as {
    readonly Temporal: Record<TemporalName, TemporalConstructor>
  }).Temporal[name]

/**
 * Reads a row or metadata using its transaction's encoding. Absent encoding
 * means the original Date-only format; version 2 also escapes user objects.
 *
 * @category stored writes
 * @since 0.3.0
 */
export const decodeOutboxValue = (value: unknown, encoding: 2 | 3 | undefined): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((entry) => decodeOutboxValue(entry, encoding))
  let record = value as Record<string, unknown>
  if (record.__type === "Date") {
    if (record.value === undefined || record.value === null) throw new Error("unreadable Date value")
    const date = new Date(record.value as string)
    if (Number.isNaN(date.getTime())) throw new Error("unreadable Date value")
    return date
  }
  if (encoding === 3 && record.__type === "Temporal") {
    const name = temporalName(record.type)
    if (name === undefined || typeof record.value !== "string") throw new Error("unreadable Temporal value")
    return temporalConstructor(name).from(record.value)
  }
  if (encoding !== undefined && record.__type === "Object") {
    if (record.value === null || typeof record.value !== "object" || Array.isArray(record.value)) {
      throw new Error("unreadable Object value")
    }
    // Unwrap once: this object's own __type is data, not another marker.
    record = record.value as Record<string, unknown>
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decodeOutboxValue(entry, encoding)]))
}

/**
 * Writes a decoded row or metadata in the current transaction encoding (3).
 * Object.fromEntries preserves own __proto__ fields as data properties.
 *
 * @category stored writes
 * @since 0.3.0
 */
export const encodeOutboxValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  if (value instanceof Date) return { __type: "Date", value: value.toISOString() }
  if (Array.isArray(value)) return value.map(encodeOutboxValue)
  const prototype = Object.getPrototypeOf(value)
  const name = prototype !== null && prototype !== Object.prototype
    ? temporalName((value as { readonly [Symbol.toStringTag]?: unknown })[Symbol.toStringTag])
    : undefined
  if (name !== undefined) {
    const toString = temporalConstructor(name).prototype.toString
    try {
      // The native method brand-checks, so a spoofed toStringTag remains user data.
      return { __type: "Temporal", type: `Temporal.${name}`, value: toString.call(value) }
    } catch {
      // A user object carrying a Temporal tag is encoded as an ordinary object.
    }
  }
  const encoded = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeOutboxValue(entry)]))
  return Object.hasOwn(value, "__type") ? { __type: "Object", value: encoded } : encoded
}
