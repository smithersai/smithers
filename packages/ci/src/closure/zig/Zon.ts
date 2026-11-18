/**
 * Reads ZON, the object notation `zig build --print-configuration` prints.
 *
 * It covers what `std.zon.Serializer` writes: structs, tuples, strings,
 * numbers, enum literals, `true`, `false` and `null`. An enum literal reads as
 * its name, and `.{}` reads as an empty list because ZON does not say whether
 * an empty container is a struct or a tuple.
 *
 * @since 0.1.0
 */

/**
 * A ZON value. An enum literal is its name as a string.
 *
 * @category models
 * @since 0.1.0
 */
export type Zon = null | boolean | number | string | ReadonlyArray<Zon> | { readonly [key: string]: Zon }

/**
 * What {@link parse} returns: the value, or where the text stopped being ZON.
 *
 * @category models
 * @since 0.1.0
 */
export type Parsed =
  | { readonly ok: true; readonly value: Zon }
  | { readonly ok: false; readonly offset: number; readonly message: string }

class Stop {
  readonly offset: number
  readonly message: string
  constructor(offset: number, message: string) {
    this.offset = offset
    this.message = message
  }
}

const identifier = /[A-Za-z_][A-Za-z0-9_]*/y
const number = /-?(?:0x[0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?)/y
const space = /(?:\s+|\/\/[^\n]*)*/y
const escapes: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "\"": "\"", "'": "'" }

const reader = (text: string) => {
  let at = 0

  const stop = (message: string): never => {
    throw new Stop(at, message)
  }

  const skip = (): void => {
    space.lastIndex = at
    space.exec(text)
    at = space.lastIndex
  }

  const match = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = at
    const found = pattern.exec(text)
    if (found === null) return undefined
    at = pattern.lastIndex
    return found[0]
  }

  const take = (token: string): boolean => {
    if (!text.startsWith(token, at)) return false
    at += token.length
    return true
  }

  const codePoint = (digits: string): string => {
    const value = Number.parseInt(digits, 16)
    return Number.isNaN(value) || value > 0x10ffff ? stop("a bad escape") : String.fromCodePoint(value)
  }

  const string = (): string => {
    let out = ""
    for (;;) {
      const next = text[at]
      if (next === undefined || next === "\n") return stop("an unfinished string")
      at += 1
      if (next === "\"") return out
      if (next !== "\\") {
        out += next
        continue
      }
      const kind = text[at]
      at += 1
      if (kind === "x") {
        out += codePoint(text.slice(at, at + 2))
        at += 2
      } else if (kind === "u" && text[at] === "{") {
        const close = text.indexOf("}", at)
        if (close === -1) return stop("a bad escape")
        out += codePoint(text.slice(at + 1, close))
        at = close + 1
      } else {
        out += (kind === undefined ? undefined : escapes[kind]) ?? stop("a bad escape")
      }
    }
  }

  /** A name after a dot: `name` or `@"any name"`. */
  const name = (): string => take("@\"") ? string() : match(identifier) ?? stop("a name was expected")

  const container = (): Zon => {
    skip()
    if (take("}")) return []
    const start = at
    if (take(".") && text[at] !== "{") {
      const first = name()
      skip()
      if (take("=")) return fields(first)
    }
    at = start
    return items()
  }

  const fields = (first: string): Zon => {
    // No prototype, so a field named `__proto__` or `constructor` is only a field.
    const out: Record<string, Zon> = Object.create(null)
    let key = first
    for (;;) {
      out[key] = value()
      skip()
      const more = take(",")
      skip()
      if (take("}")) return out
      if (!more || !take(".")) return stop("a field was expected")
      key = name()
      skip()
      if (!take("=")) return stop("= was expected")
    }
  }

  const items = (): Zon => {
    const out: Array<Zon> = []
    for (;;) {
      out.push(value())
      skip()
      const more = take(",")
      skip()
      if (take("}")) return out
      if (!more) return stop("a comma was expected")
    }
  }

  const value = (): Zon => {
    skip()
    if (take(".{")) return container()
    if (take(".")) return name()
    if (take("\"")) return string()
    if (take("true")) return true
    if (take("false")) return false
    if (take("null")) return null
    const digits = match(number)
    return digits === undefined ? stop("a value was expected") : Number(digits.replaceAll("_", ""))
  }

  const document = (): Zon => {
    const out = value()
    skip()
    return at === text.length ? out : stop("text after the value")
  }

  return document
}

/**
 * Parses one ZON value.
 *
 * @param text - The ZON text.
 * @returns The value, or the offset and reason parsing stopped.
 * @throws {never}
 *
 * @category parsing
 * @since 0.1.0
 */
export const parse = (text: string): Parsed => {
  try {
    return { ok: true, value: reader(text)() }
  } catch (error) {
    // Anything else is the runtime refusing the input, such as nesting deeper than its stack.
    return error instanceof Stop
      ? { ok: false, offset: error.offset, message: error.message }
      : { ok: false, offset: 0, message: "nested too deeply" }
  }
}

/**
 * A field of a ZON struct, or `undefined` when `value` is not a struct or
 * lacks the field.
 *
 * @throws {never}
 *
 * @category accessors
 * @since 0.1.0
 */
export const field = (value: Zon | undefined, key: string): Zon | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { readonly [key: string]: Zon })[key]
    : undefined

/**
 * A ZON tuple's items, or an empty list when `value` is not a tuple.
 *
 * @throws {never}
 *
 * @category accessors
 * @since 0.1.0
 */
export const list = (value: Zon | undefined): ReadonlyArray<Zon> => Array.isArray(value) ? value : []
