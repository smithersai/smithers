/**
 * Order-free collections for durable identity (VIP-44).
 *
 * `Schema.ReadonlySet` and `Schema.ReadonlyMap` encode in insertion order, and
 * {@link Canonical} sorts object keys but keeps array order, so two equal sets
 * inserted in different orders hash differently. {@link sortCollections} runs
 * before encoding and removes that difference.
 *
 * @since 1.0.0
 */

/**
 * Objects whose state lives in internal slots. Copying one through its
 * prototype would lose the slot, and none of them can hold a collection, so
 * the walk treats them as leaves.
 */
const isSlotted = (value: object): boolean =>
  value instanceof Date
  || value instanceof RegExp
  || value instanceof ArrayBuffer
  || ArrayBuffer.isView(value)
  || value instanceof WeakMap
  || value instanceof WeakSet
  || value instanceof Promise
  || (typeof URL === "function" && value instanceof URL)

const isObject = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function"

/** The values one walked object refers to: its own data properties, then its entries. */
const children = (value: object): Array<unknown> => {
  if (typeof value === "function" || isSlotted(value)) return []
  const out: Array<unknown> = []
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)!
    if ("value" in descriptor) out.push(descriptor.value)
  }
  if (value instanceof Set) {
    for (const entry of value) out.push(entry)
  } else if (value instanceof Map) {
    for (const [key, entry] of value) out.push(key, entry)
  }
  return out
}

/**
 * Every object that reaches a `Set` or a `Map`, including the collections
 * themselves. Propagating over reverse edges keeps cycles and shared
 * references exact: an object is copied only when something below it changes.
 */
const dirtyObjects = (root: unknown): Set<object> => {
  const parents = new Map<object, Array<object>>()
  const pending: Array<object> = []
  const dirty = new Set<object>()
  if (isObject(root)) {
    parents.set(root, [])
    pending.push(root)
  }
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let kids: Array<unknown>
    try {
      kids = children(next)
      if (next instanceof Set || next instanceof Map) dirty.add(next)
    } catch {
      // An object that cannot be inspected, such as a revoked proxy, is a leaf.
      kids = []
    }
    for (const child of kids) {
      if (!isObject(child)) continue
      const known = parents.get(child)
      if (known === undefined) {
        parents.set(child, [next])
        pending.push(child)
      } else {
        known.push(next)
      }
    }
  }
  const spread = [...dirty]
  for (let next = spread.pop(); next !== undefined; next = spread.pop()) {
    for (const parent of parents.get(next)!) {
      if (!dirty.has(parent)) {
        dirty.add(parent)
        spread.push(parent)
      }
    }
  }
  return dirty
}

const constructorName = (prototype: object | null): string => {
  if (prototype === null) return ""
  const descriptor = Reflect.getOwnPropertyDescriptor(prototype, "constructor")
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function"
    ? String(descriptor.value.name)
    : ""
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/**
 * A stable text rank of a sorted value. Strings are JSON-quoted and every
 * container is tagged and delimited, so distinct data never shares a rank.
 * Object members are ranked under their own string keys, enumerable or not, in
 * UTF-16 code-unit order; an accessor ranks as `get` without being invoked.
 * A back edge to an enclosing object ranks as its distance.
 */
const rank = (value: unknown, path: Array<object> = []): string => {
  switch (typeof value) {
    case "string":
      return `s${JSON.stringify(value)}`
    case "number":
      return Object.is(value, -0) ? "n-0" : `n${value}`
    case "bigint":
      return `b${value}`
    case "boolean":
      return value ? "t" : "f"
    case "undefined":
      return "u"
    case "symbol":
      return `y${JSON.stringify(value.description ?? "")}`
    case "function":
      try {
        return `F${JSON.stringify(value.name)}`
      } catch {
        return "x"
      }
  }
  if (value === null) return "z"
  try {
    return rankObject(value as object, path)
  } catch {
    // An object that cannot be inspected, such as a revoked proxy, has no rank.
    return "x"
  }
}

const rankObject = (object: object, path: Array<object>): string => {
  const back = path.lastIndexOf(object)
  if (back !== -1) return `^${path.length - back}`
  if (object instanceof Date) return `d${object.getTime()}`
  if (object instanceof RegExp) return `r${JSON.stringify(object.source)}${JSON.stringify(object.flags)}`
  if (typeof URL === "function" && object instanceof URL) return `l${JSON.stringify(object.href)}`
  if (ArrayBuffer.isView(object)) {
    const bytes = new Uint8Array(object.buffer, object.byteOffset, object.byteLength)
    return `v${JSON.stringify(object.constructor.name)}[${bytes.join(",")}]`
  }
  if (object instanceof ArrayBuffer) return `a[${new Uint8Array(object).join(",")}]`
  path.push(object)
  try {
    let entries = ""
    if (object instanceof Set) {
      entries = `S[${Array.from(object, (entry) => rank(entry, path)).join(",")}]`
    } else if (object instanceof Map) {
      entries = `M[${Array.from(object, ([key, entry]) => `${rank(key, path)}:${rank(entry, path)}`).join(",")}]`
    }
    const members = Reflect.ownKeys(object)
      .filter((key): key is string => typeof key === "string")
      .sort(compareText)
      .map((key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key)!
        const member = "value" in descriptor ? rank(descriptor.value, path) : "get"
        return `${JSON.stringify(key)}:${member}`
      })
    return `o${JSON.stringify(constructorName(Object.getPrototypeOf(object)))}${entries}{${members.join(",")}}`
  } finally {
    path.pop()
  }
}

/** Sorts values by rank, keeping the original order of equal ranks. */
const byRank = <A>(values: ReadonlyArray<A>, rankOf: (value: A) => string): Array<A> =>
  values
    .map((value) => ({ value, rank: rankOf(value) }))
    .sort((left, right) => compareText(left.rank, right.rank))
    .map(({ value }) => value)

const keepIntegrity = (source: object, copy: object): void => {
  if (Object.isFrozen(source)) Object.freeze(copy)
  else if (Object.isSealed(source)) Object.seal(copy)
  else if (!Object.isExtensible(source)) Object.preventExtensions(copy)
}

const shellOf = (value: object): object => {
  const prototype = Object.getPrototypeOf(value)
  const shell: object = value instanceof Set
    ? new Set()
    : value instanceof Map
    ? new Map()
    : Array.isArray(value)
    ? []
    : Object.create(prototype)
  if (Object.getPrototypeOf(shell) !== prototype) Object.setPrototypeOf(shell, prototype)
  return shell
}

/**
 * Copies `value` with every `Set`'s entries and every `Map`'s entries in
 * sorted order, at every depth, so that equal collections encode to equal
 * bytes.
 *
 * - Entries are ordered by a stable text rank of their sorted value, compared
 *   in UTF-16 code units. A `Map` orders by key, then by value.
 * - Arrays keep their order, because array order is meaningful. Object keys
 *   are left alone, because `Canonical` already sorts them.
 * - It walks the value, not a Schema. Every own data property is visited,
 *   enumerable or not, and a copy keeps its prototype, property descriptors,
 *   and frozen, sealed or non-extensible state. State held in private class
 *   fields or internal slots is unreachable, so a class that keeps a
 *   collection there must encode it in a stable order itself.
 * - It copies only what reaches a collection. Everything else, including any
 *   object a collection holds that holds none itself, keeps its reference.
 *   Cycles and shared references survive the copy.
 * - Accessors are copied as accessors and never invoked. `Date`, `RegExp`,
 *   `URL`, buffers and typed arrays are leaves.
 *
 * @example
 * ```ts
 * import { sortCollections } from "@smthrs/canonical"
 *
 * [...sortCollections(new Set(["b", "a"]))] // ["a", "b"]
 * ```
 *
 * @param value - Any value; it is never mutated.
 * @returns `value` itself when it reaches no collection, otherwise a sorted copy.
 *
 * @category transformations
 * @since 1.0.0
 */
export const sortCollections = <A>(value: A): A => {
  const dirty = dirtyObjects(value)
  if (dirty.size === 0) return value
  const copies = new Map<object, object>()
  const copy = (current: unknown): unknown => {
    if (!isObject(current) || !dirty.has(current)) return current
    const known = copies.get(current)
    if (known !== undefined) return known
    const shell = shellOf(current)
    copies.set(current, shell)
    if (current instanceof Set) {
      const target = shell as Set<unknown>
      for (const entry of byRank(Array.from(current, copy), (entry) => rank(entry))) target.add(entry)
    } else if (current instanceof Map) {
      const target = shell as Map<unknown, unknown>
      const entries = Array.from(current, ([key, entry]) => [copy(key), copy(entry)] as const)
      for (const [key, entry] of byRank(entries, ([key, entry]) => `${rank(key)}\u0000${rank(entry)}`)) {
        target.set(key, entry)
      }
    }
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key)!
      if ("value" in descriptor) descriptor.value = copy(descriptor.value)
      Reflect.defineProperty(shell, key, descriptor)
    }
    keepIntegrity(current, shell)
    return shell
  }
  return copy(value) as A
}
