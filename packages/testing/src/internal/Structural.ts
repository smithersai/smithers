/**
 * One structural canonicalizer and one structural equality, shared by every
 * assertion in the package that has to decide whether two arbitrary values are
 * the same.
 *
 * Four modules used to carry a private copy of the same nine-line `same`, and
 * each copy compared a non-plain object by `Object.keys`, which is empty for a
 * `Date`, a `Map`, a `Set`, and most class instances. Two different `Date`s,
 * a `Map` beside a `Set`, `-0` beside `0`, and `NaN` beside `Infinity` all
 * compared equal, so a replay pin certifying a third-party engine, and the
 * fixture-drift detector in `Divergence`, both passed on genuinely different
 * journals.
 *
 * {@link canonical} is total: it tags every value it cannot render as plain
 * JSON rather than throwing, so a cycle, a `BigInt`, or a symbol reaches the
 * caller as a comparable marker instead of a `RangeError` or a `TypeError`
 * escaping a typed error channel.
 *
 * This module is internal: `./internal/*` is null-mapped in the export map and
 * carries no compatibility promise.
 *
 * @since 0.0.0
 */

/**
 * Maximum plain-data depth copied by snapshots or rendered in diagnostics.
 *
 * This is deliberately the same 128-level boundary as
 * `Fixture.canonicalize`: a snapshot must stop before the host stack does, then
 * leave the original tail for the fixture encoder to reject with its typed
 * `too-deep` error.
 *
 * Exported because a caller that walks a {@link snapshot} has to stop at the
 * same boundary: below it the value is the caller's own object rather than the
 * copy, so following it further both recurses without a bound and reaches
 * something the snapshot does not own.
 *
 * @since 0.0.0
 * @category encoding
 */
export const maximumDepth = 128

// Registered symbols cannot be WeakMap keys. Keeping their small process
// identity table strongly is preferable to making `canonical` partial again.
const symbolIdentities = new Map<symbol, number>()
const functionIdentities = new WeakMap<object, number>()
let nextSymbolIdentity = 0
let nextFunctionIdentity = 0

/** Returns one stable process-local ordinal for a symbol reference. */
const symbolIdentity = (value: symbol): number => {
  const existing = symbolIdentities.get(value)
  if (existing !== undefined) return existing
  const identity = nextSymbolIdentity++
  symbolIdentities.set(value, identity)
  return identity
}

/** Returns one stable process-local ordinal for a function reference. */
const functionIdentity = (value: object): number => {
  const existing = functionIdentities.get(value)
  if (existing !== undefined) return existing
  const identity = nextFunctionIdentity++
  functionIdentities.set(value, identity)
  return identity
}

/** Distinguishes the numbers `JSON.stringify` collapses. */
const number = (value: number): string => {
  if (Number.isNaN(value)) return `!{"_tag":"NaN"}`
  if (value === Number.POSITIVE_INFINITY) return `!{"_tag":"Infinity","sign":1}`
  if (value === Number.NEGATIVE_INFINITY) return `!{"_tag":"Infinity","sign":-1}`
  // `Object.is` separates the two zeros; `JSON.stringify` renders both as `0`.
  return Object.is(value, -0) ? `!{"_tag":"NegativeZero"}` : JSON.stringify(value)
}

// An exclamation mark starts only internal markers; ordinary records, arrays,
// and JSON scalars cannot produce it at a value boundary.
const objectIdentities = new WeakMap<object, number>()
let nextObjectIdentity = 0

const objectIdentity = (value: object): number => {
  const existing = objectIdentities.get(value)
  if (existing !== undefined) return existing
  const identity = nextObjectIdentity++
  objectIdentities.set(value, identity)
  return identity
}

interface Part {
  readonly value?: unknown
  readonly text?: string
}

interface Rendering {
  readonly parts: ReadonlyArray<Part>
  readonly format: (parts: ReadonlyArray<string>) => string
}

/** Descriptors keep accessors comparable without executing user code. */
const member = (descriptor: PropertyDescriptor): Part =>
  "value" in descriptor
    ? { value: descriptor.value }
    : { text: `!{"_tag":"Accessor","get":${canonical(descriptor.get)},"set":${canonical(descriptor.set)}}` }

/** String keys and symbol identities have separate canonical namespaces. */
const record = (value: object): Rendering => {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(value).sort()
  const symbols = Object.getOwnPropertySymbols(value)
    .filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))
    .sort((left, right) => symbolIdentity(left) - symbolIdentity(right))
  const parts = [...keys, ...symbols].map((key) => member(Reflect.get(descriptors, key) as PropertyDescriptor))
  return {
    parts,
    format: (rendered) => {
      const fields = `{${keys.map((key, index) => `${JSON.stringify(key)}:${rendered[index]}`).join(",")}}`
      return symbols.length === 0
        ? fields
        : `!{"_tag":"Record","fields":${fields},"symbols":[${
          symbols.map((key, index) => `[${canonical(key)},${rendered[keys.length + index]}]`).join(",")
        }]}`
    }
  }
}

const inspect = (value: object): Rendering => {
  if (Array.isArray(value)) {
    const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value)
    const parts: Array<Part> = []
    for (let index = 0; index < descriptors.length!.value; index++) {
      const descriptor = descriptors[index]
      parts.push(descriptor === undefined ? { text: `!{"_tag":"Hole"}` } : member(descriptor))
    }
    return { parts, format: (items) => `[${items.join(",")}]` }
  }
  if (value instanceof Date) {
    const time = value.getTime()
    return {
      parts: [],
      format: () => `!{"_tag":"Date","value":${Number.isNaN(time) ? `"Invalid Date"` : String(time)}}`
    }
  }
  if (value instanceof RegExp) {
    const text = String(value)
    return { parts: [], format: () => `!{"_tag":"RegExp","value":${JSON.stringify(text)}}` }
  }
  if (value instanceof Map) {
    return {
      parts: [...value].flatMap(([key, item]) => [{ value: key }, { value: item }]),
      format: (parts) => {
        const entries: Array<string> = []
        for (let index = 0; index < parts.length; index += 2) entries.push(`[${parts[index]},${parts[index + 1]}]`)
        return `!{"_tag":"Map","entries":[${entries.sort().join(",")}]}`
      }
    }
  }
  if (value instanceof Set) {
    return {
      parts: [...value].map((item) => ({ value: item })),
      format: (parts) => `!{"_tag":"Set","values":[${[...parts].sort().join(",")}]}`
    }
  }
  if (value instanceof Error) {
    // Stack traces vary between otherwise identical failures.
    const { stack: _stack, ...own } = value as Error & Record<string, unknown>
    const fields = record(own)
    const name = JSON.stringify(value.name)
    const message = JSON.stringify(value.message)
    return {
      parts: fields.parts,
      format: (parts) => `!{"_tag":"Error","name":${name},"message":${message},"fields":${fields.format(parts)}}`
    }
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  const fields = record(value)
  if (prototype === Object.prototype || prototype === null) return fields
  const name = typeof (prototype as { constructor?: { name?: unknown } })?.constructor?.name === "string"
    ? (prototype as { constructor: { name: string } }).constructor.name
    : "Object"
  return {
    parts: fields.parts,
    format: (parts) => `!{"_tag":"Foreign","constructor":${JSON.stringify(name)},"fields":${fields.format(parts)}}`
  }
}

/** An explicit work stack keeps deeply nested equality independent of host stack limits. */
const render = (value: unknown, depthLimit: number): string => {
  const ancestors = new Set<object>()
  const work: Array<() => void> = []
  let result = ""
  const visit = (value: unknown, depth: number, accept: (text: string) => void): void => {
    try {
      visitValue(value, depth, accept)
    } catch {
      // Proxies can refuse even a function's name. Compare them only by reference.
      accept("!{\"_tag\":\"Opaque\",\"identity\":" + String(objectIdentity(value as object)) + "}")
    }
  }
  const visitValue = (value: unknown, depth: number, accept: (text: string) => void): void => {
    if (value === undefined) return accept(`!{"_tag":"Undefined"}`)
    if (value === null) return accept("null")
    switch (typeof value) {
      case "number":
        return accept(number(value))
      case "string":
      case "boolean":
        return accept(JSON.stringify(value))
      case "bigint":
        return accept(`!{"_tag":"BigInt","value":${JSON.stringify(String(value))}}`)
      case "symbol":
        return accept(
          `!{"_tag":"Symbol","description":${JSON.stringify(value.description ?? null)},"identity":${
            symbolIdentity(value)
          }}`
        )
      case "function":
        return accept(`!{"_tag":"Function","name":${JSON.stringify(value.name)},"identity":${functionIdentity(value)}}`)
    }
    if (depth >= depthLimit) return accept(`!{"_tag":"TooDeep","identity":${objectIdentity(value)}}`)
    if (ancestors.has(value)) return accept(`!{"_tag":"Circular"}`)
    const rendering = inspect(value)
    ancestors.add(value)
    const rendered: Array<string> = []
    work.push(() => {
      ancestors.delete(value)
      accept(rendering.format(rendered))
    })
    for (let index = rendering.parts.length - 1; index >= 0; index--) {
      const part = rendering.parts[index]!
      work.push(() => {
        if (part.text !== undefined) rendered[index] = part.text
        else {
          visit(part.value, depth + 1, (text) => {
            rendered[index] = text
          })
        }
      })
    }
  }
  visit(value, 0, (text) => {
    result = text
  })
  while (work.length > 0) work.pop()!()
  return result
}

/**
 * Renders any value as a canonical string: object keys sort, array order is
 * retained, and every value JSON cannot express is tagged rather than dropped.
 * Never throws.
 *
 * @since 0.0.0
 * @category encoding
 */
export const canonical = (value: unknown): string => render(value, maximumDepth)

/**
 * Structural equality using the same rendering as {@link canonical}, without
 * its diagnostic depth limit. An explicit stack compares deeply nested values
 * by their contents rather than the identity of their truncated tails.
 *
 * @since 0.0.0
 * @category encoding
 */
export const same = (left: unknown, right: unknown): boolean =>
  Object.is(left, right) || render(left, Infinity) === render(right, Infinity)

const copy = (value: unknown, copies: Map<object, object>, depth: number): unknown => {
  if (depth >= maximumDepth || typeof value !== "object" || value === null) return value
  if (copies.has(value)) return copies.get(value)
  try {
    const array = Array.isArray(value)
    const prototype: unknown = Object.getPrototypeOf(value)
    // Leave unsupported values for the fixture encoder to reject at their path.
    if (array && prototype !== Array.prototype) return value
    if (!array && prototype !== Object.prototype && prototype !== null) return value
    const result = array ? [] : {}
    copies.set(value, result)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    // Symbols and accessors must survive so the fixture encoder can reject
    // them. Defining data properties also keeps __proto__ an ordinary own key.
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors]!
      Object.defineProperty(
        result,
        key,
        "value" in descriptor
          ? { ...descriptor, value: copy(descriptor.value, copies, depth + 1) }
          : descriptor
      )
    }
    return result
  } catch {
    // Reflective operations on a proxy may throw. Keep the original for the
    // encoder's guarded inspection, as with other unsupported values.
    return value
  } finally {
    // Memoize the active path only: shared branches can reach the depth cap at
    // different distances, so a reused copy could expose an unowned tail.
    copies.delete(value)
  }
}

/**
 * A deep copy of the plain-record and array spine of `value`, so a later
 * mutation of the caller's object cannot change what was recorded.
 *
 * Unlike `structuredClone` it never throws. Plain cycles point back into the
 * copy; functions and class instances pass through by reference, leaving the
 * fixture encoder to report it with a typed error naming its path.
 *
 * @since 0.0.0
 * @category encoding
 */
export const snapshot = <A>(value: A): A => copy(value, new Map<object, object>(), 0) as A

/**
 * Code-unit ordering, the comparator every stable rendering in this package
 * sorts with.
 *
 * `String.prototype.localeCompare` with no locale argument resolves the host
 * default locale and its ICU collation, so a plan whose node ids contain a
 * non-ASCII character renders in a different order on a machine whose locale
 * differs. Snapshot assertions promise byte-identical output, and code-unit
 * order is the only ordering that keeps that promise. It is also the order the
 * bare `Array.prototype.sort` used beside these comparators already produces.
 *
 * @since 0.0.0
 * @category encoding
 */
export const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
