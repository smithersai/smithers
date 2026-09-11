/**
 * The one canonical JSON encoder both serializers use.
 *
 * A report embeds the raw output of an arbitrary target flow, so the value
 * being serialized is not JSON and cannot be assumed to be finite, acyclic, or
 * even readable. A recursive walker over `JSON.stringify` answered that with a
 * `RangeError` thrown out of a function typed `string`. This encoder is total
 * instead: every shape JSON cannot express is replaced by a marker that names
 * what was there, so a report of a broken run is still a report.
 *
 * @since 0.1.0
 */

/**
 * The nesting depth beyond which a value is replaced by a marker.
 *
 * @since 0.1.0
 * @private
 */
const maxDepth = 64

/**
 * Default cap on an embedded string, in UTF-16 code units.
 *
 * @since 0.1.0
 * @private
 */
const maxStringLength = 8192

/**
 * Total number of values one encode may visit.
 *
 * The cycle detector forgets a value once it leaves it, which is what keeps a
 * value referenced twice from being reported as a cycle. The cost is that a
 * shared acyclic graph is re-expanded at every reference, so `n` nested
 * two-child wrappers over one shared child expand to `2^n` values while
 * staying far below {@link maxDepth}. The ceiling is roughly three times what
 * a suite at its declared case limit produces.
 *
 * @since 0.1.0
 * @private
 */
const maxNodes = 2_000_000

/**
 * Approximate cap on the encoded output, in UTF-16 code units.
 *
 * @since 0.1.0
 * @private
 */
const maxBytes = 33_554_432

/**
 * Marker left where a total budget ran out.
 *
 * @since 0.1.0
 * @private
 */
const budgetExceeded = "[budget exceeded]"

/**
 * Options accepted by {@link encode}.
 *
 * @since 0.1.0
 * @private
 */
interface Options {
  /** Cap on embedded strings; `undefined` keeps them whole. */
  readonly maxStringLength?: number | undefined
  /** Cap on values visited; defaults to {@link maxNodes}. */
  readonly maxNodes?: number | undefined
  /** Cap on encoded output length; defaults to {@link maxBytes}. */
  readonly maxBytes?: number | undefined
}

/** Remaining total work, decremented in traversal order so truncation is stable. */
interface Budget {
  nodes: number
  bytes: number
}

/**
 * Orders keys by UTF-16 code unit, never by locale.
 *
 * @since 0.1.0
 * @private
 */
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const truncate = (value: string, limit: number | undefined): string =>
  limit === undefined || value.length <= limit
    ? value
    : `${value.slice(0, limit)}[truncated ${value.length - limit} chars]`

const primitive = (value: unknown, options: Options): unknown => {
  if (typeof value === "string") return truncate(value, options.maxStringLength)
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "[NaN]"
    if (value === Number.POSITIVE_INFINITY) return "[Infinity]"
    if (value === Number.NEGATIVE_INFINITY) return "[-Infinity]"
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === "bigint") return `[bigint ${value}]`
  if (typeof value === "function") return "[function]"
  if (typeof value === "symbol") return "[symbol]"
  return value
}

const unreadable = (cause: unknown): string => {
  try {
    return `[unreadable: ${String(cause)}]`
  } catch {
    return "[unreadable]"
  }
}

const entriesOf = (value: object): ReadonlyArray<readonly [string, unknown]> =>
  Object.keys(value).map((key) => {
    try {
      return [key, (value as { readonly [key: string]: unknown })[key]] as const
    } catch (cause) {
      return [key, unreadable(cause)] as const
    }
  })

const objectOf = (
  entries: ReadonlyArray<readonly [string, unknown]>,
  depth: number,
  seen: Set<object>,
  options: Options,
  budget: Budget
): object =>
  Object.fromEntries(
    entries
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => {
        // The key is rendered too, so a wide object of long keys spends the
        // byte budget even when every value is a marker.
        budget.bytes -= key.length + 3
        return [key, walk(entry, depth + 1, seen, options, budget)]
      })
  )

const walk = (value: unknown, depth: number, seen: Set<object>, options: Options, budget: Budget): unknown => {
  if (budget.nodes <= 0 || budget.bytes <= 0) return budgetExceeded
  budget.nodes -= 1
  if (value === null || typeof value !== "object") {
    const encoded = primitive(value, options)
    budget.bytes -= typeof encoded === "string" ? encoded.length + 2 : 8
    return encoded
  }
  if (seen.has(value)) return "[circular]"
  if (depth > maxDepth) return "[depth exceeded]"
  budget.bytes -= 2
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[invalid Date]" : value.toISOString()
    seen.add(value)
    try {
      if (value instanceof Error) {
        const properties = new Map(entriesOf(value))
        properties.set("name", String(value.name))
        properties.set("message", String(value.message))
        return objectOf([...properties], depth, seen, options, budget)
      }
      if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1, seen, options, budget))
      if (value instanceof Set) return [...value].map((entry) => walk(entry, depth + 1, seen, options, budget))
      if (value instanceof Map) {
        return [...value.entries()]
          .map((
            [key, entry]
          ) => [walk(key, depth + 1, seen, options, budget), walk(entry, depth + 1, seen, options, budget)])
      }
      return objectOf(entriesOf(value), depth, seen, options, budget)
    } finally {
      seen.delete(value)
    }
  } catch (cause) {
    return unreadable(cause)
  }
}

/**
 * Rewrites a value into a shape `JSON.stringify` renders deterministically.
 *
 * Object keys are sorted by code unit, `-0` becomes `0`, and `undefined`
 * members are dropped. Everything JSON cannot express becomes a bracketed
 * marker rather than a throw or a silent `null`: `[circular]`,
 * `[depth exceeded]`, `[NaN]`, `[Infinity]`, `[-Infinity]`, `[bigint n]`,
 * `[function]`, `[symbol]`, and `[unreadable: …]` when a foreign operation
 * throws. An `Error` becomes an object containing its own enumerable fields
 * plus `name` and `message`, so typed error fields survive serialization. A
 * `Date` becomes its ISO string, a `Set` an array, and a `Map` an array of
 * key/value pairs.
 *
 * Traversal is bounded in total, not only per branch: once {@link maxNodes}
 * values or {@link maxBytes} output code units are spent, every remaining
 * value becomes `[budget exceeded]`. The budget is spent in traversal order,
 * and traversal order is fixed by the key sort, so one value always truncates
 * at the same place.
 *
 * @since 0.1.0
 * @private
 */
const encode = (value: unknown, options: Options = {}): unknown =>
  walk(value, 0, new Set<object>(), options, {
    nodes: options.maxNodes ?? maxNodes,
    bytes: options.maxBytes ?? maxBytes
  })

/**
 * Serializes a value as canonical JSON with a trailing newline.
 *
 * @since 0.1.0
 * @private
 */
const stringify = (value: unknown, options: Options = {}): string => `${JSON.stringify(encode(value, options))}\n`

/**
 * The canonical JSON encoder: its limits, key order, and serializers.
 *
 * @since 0.1.0
 * @private
 */
export const CanonicalJson = {
  maxDepth,
  maxStringLength,
  maxNodes,
  maxBytes,
  budgetExceeded,
  compareText,
  encode,
  stringify
} as const
