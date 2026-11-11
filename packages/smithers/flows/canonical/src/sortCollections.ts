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

/**
 * The rank of an object whose inspection threw, such as a revoked proxy. A
 * `RangeError` is the engine's report of an exhausted call stack or an
 * over-long string, which says nothing about the object, so it is rethrown
 * and never becomes a rank.
 */
const uninspectable = (error: unknown): "x" => {
  if (error instanceof RangeError) throw error
  return "x"
}

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
    } catch (error) {
      // An object that cannot be inspected, such as a revoked proxy, is a leaf.
      uninspectable(error)
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
 *
 * A rank is its text, or a node whose parts spell that text in order. A node
 * shares the ranks of the objects below it instead of repeating their text,
 * so a deep value or one with shared references takes space in proportion to
 * its objects, not to its expanded tree.
 */
type Rank = string | RankNode

interface RankNode {
  /** Unique per distinct text among the nodes of one {@link ranker}. */
  readonly id: number
  /** Never empty, and no part is the empty string. */
  readonly parts: ReadonlyArray<Rank>
}

/** A rank at most this long is kept as text and spliced into its parent's. */
const inlineLimit = 1024

/** The rank of a value that holds no other value, or `undefined` for an object. */
const leafRank = (value: unknown): string | undefined => {
  switch (typeof value) {
    case "string":
      return `s${JSON.stringify(value)}`
    case "number":
      // `String(-0)` is "0": codecs encode -0 as 0, so it must not order apart.
      return `n${value}`
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
      } catch (error) {
        return uninspectable(error)
      }
    default:
      return value === null ? "z" : undefined
  }
}

/**
 * One object's own part of its rank: `texts[0]`, then for each child its rank
 * followed by the next text. Leaf members are already spliced into the texts.
 */
interface Shape {
  readonly texts: Array<string>
  readonly children: Array<object>
}

/** The rank of a slotted leaf, or the shape of an object that holds values. */
const shapeOf = (object: object): string | Shape => {
  if (object instanceof Date) return `d${object.getTime()}`
  if (object instanceof RegExp) return `r${JSON.stringify(object.source)}${JSON.stringify(object.flags)}`
  if (typeof URL === "function" && object instanceof URL) return `l${JSON.stringify(object.href)}`
  if (ArrayBuffer.isView(object)) {
    const bytes = new Uint8Array(object.buffer, object.byteOffset, object.byteLength)
    return `v${JSON.stringify(object.constructor.name)}[${bytes.join(",")}]`
  }
  if (object instanceof ArrayBuffer) return `a[${new Uint8Array(object).join(",")}]`
  const texts: Array<string> = []
  const children: Array<object> = []
  let text = `o${JSON.stringify(constructorName(Object.getPrototypeOf(object)))}`
  const add = (value: unknown): void => {
    const leaf = leafRank(value)
    if (leaf === undefined) {
      texts.push(text)
      children.push(value as object)
      text = ""
    } else {
      text += leaf
    }
  }
  let separator = ""
  if (object instanceof Set) {
    text += "S["
    for (const entry of Array.from(object)) {
      text += separator
      add(entry)
      separator = ","
    }
    text += "]"
  } else if (object instanceof Map) {
    text += "M["
    for (const [key, entry] of Array.from(object)) {
      text += separator
      add(key)
      text += ":"
      add(entry)
      separator = ","
    }
    text += "]"
  }
  text += "{"
  separator = ""
  const keys = Reflect.ownKeys(object).filter((key): key is string => typeof key === "string").sort(compareText)
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(object, key)!
    text += `${separator}${JSON.stringify(key)}:`
    if ("value" in descriptor) add(descriptor.value)
    else text += "get"
    separator = ","
  }
  texts.push(`${text}}`)
  return { texts, children }
}

/** An object whose members are being ranked. */
interface RankFrame extends Shape {
  readonly object: object
  /** How many children are ranked. */
  index: number
  /** The rank so far: finished parts, then the text still growing. */
  readonly parts: Array<Rank>
  text: string
  /**
   * The shallowest enclosing object a back edge below this one points at, as
   * its index on the stack; `Infinity` when there is none, and -1 when the
   * rank read a copy that is still being filled.
   */
  lowest: number
}

/**
 * Ranks values with an explicit stack, so depth is bounded by memory, not by
 * the call stack. `building` holds the copies that are not filled yet.
 *
 * The rank of an object is remembered unless a back edge below it points at
 * it or above it, or it read an unfilled copy: only then does the rank depend
 * on where the walk met the object. An object on no cycle is therefore ranked
 * once however many times it is shared.
 */
const ranker = (building: ReadonlySet<object>): (value: unknown) => Rank => {
  const known = new Map<object, Rank>()
  const nodes = new Map<string, RankNode>()

  /** One node per distinct text, so equal subtrees compare by reference. */
  const node = (parts: ReadonlyArray<Rank>): RankNode => {
    // Rank text holds no raw control character, so U+0000 marks a child unambiguously.
    const key = parts.map((part) => typeof part === "string" ? part : `\u0000${part.id}\u0000`).join("")
    const existing = nodes.get(key)
    if (existing !== undefined) return existing
    const made: RankNode = { id: nodes.size, parts }
    nodes.set(key, made)
    return made
  }

  return (root) => {
    const leaf = leafRank(root)
    if (leaf !== undefined) return leaf
    const frames: Array<RankFrame> = []
    const onPath = new Map<object, number>()

    /** The rank of `object` when no walk is needed; otherwise starts its walk. */
    const enter = (object: object): Rank | undefined => {
      const back = onPath.get(object)
      if (back !== undefined) {
        const parent = frames[frames.length - 1]!
        parent.lowest = Math.min(parent.lowest, back)
        return `^${frames.length - back}`
      }
      const remembered = known.get(object)
      if (remembered !== undefined) return remembered
      let shape: string | Shape
      try {
        shape = shapeOf(object)
      } catch (error) {
        // An object that cannot be inspected, such as a revoked proxy, has no rank.
        shape = uninspectable(error)
      }
      if (typeof shape === "string") return shape
      onPath.set(object, frames.length)
      frames.push({
        object,
        texts: shape.texts,
        children: shape.children,
        index: 0,
        parts: [],
        text: shape.texts[0]!,
        lowest: building.has(object) ? -1 : Infinity
      })
      return undefined
    }

    /** Adds a ranked child and the text that follows it. */
    const append = (frame: RankFrame, rank: Rank): void => {
      if (typeof rank === "string") {
        frame.text += rank
      } else {
        frame.parts.push(frame.text, rank)
        frame.text = ""
      }
      frame.index += 1
      frame.text += frame.texts[frame.index]!
    }

    const first = enter(root as object)
    if (first !== undefined) return first
    for (;;) {
      const frame = frames[frames.length - 1]!
      if (frame.index < frame.children.length) {
        const rank = enter(frame.children[frame.index]!)
        if (rank !== undefined) append(frame, rank)
        continue
      }
      frames.pop()
      onPath.delete(frame.object)
      const rank = frame.parts.length === 0 && frame.text.length <= inlineLimit
        ? frame.text
        : node([...frame.parts, frame.text])
      if (frame.lowest > frames.length) known.set(frame.object, rank)
      const parent = frames[frames.length - 1]
      if (parent === undefined) return rank
      parent.lowest = Math.min(parent.lowest, frame.lowest)
      append(parent, rank)
    }
  }
}

/** A position in the text a rank spells. */
interface RankReader {
  readonly stack: Array<{ readonly parts: ReadonlyArray<Rank>; index: number }>
  text: string
  at: number
  done: boolean
}

const reading = (rank: Rank): RankReader => ({ stack: [{ parts: [rank], index: 0 }], text: "", at: 0, done: false })

/** Moves a reader that has used up its text to its next part, or marks it done. */
const advance = (reader: RankReader): Rank | undefined => {
  for (
    let frame = reader.stack[reader.stack.length - 1];
    frame !== undefined;
    frame = reader.stack[reader.stack.length - 1]
  ) {
    if (frame.index < frame.parts.length) return frame.parts[frame.index++]
    reader.stack.pop()
  }
  return undefined
}

const load = (reader: RankReader, part: Rank | undefined): void => {
  if (part === undefined) {
    reader.done = true
  } else if (typeof part === "string") {
    reader.text = part
    reader.at = 0
  } else {
    reader.stack.push({ parts: part.parts, index: 0 })
  }
}

/**
 * Compares the texts two ranks spell, in UTF-16 code units, without building
 * either text. Two readers that reach the same part at once step over it.
 */
const compareRank = (left: Rank, right: Rank): number => {
  if (typeof left === "string" && typeof right === "string") return compareText(left, right)
  const a = reading(left)
  const b = reading(right)
  for (;;) {
    const length = Math.min(a.text.length - a.at, b.text.length - b.at)
    for (let offset = 0; offset < length; offset++) {
      const unitA = a.text.charCodeAt(a.at + offset)
      const unitB = b.text.charCodeAt(b.at + offset)
      if (unitA !== unitB) return unitA < unitB ? -1 : 1
    }
    a.at += length
    b.at += length
    const endA = a.at === a.text.length
    const endB = b.at === b.text.length
    if (endA && endB) {
      const partA = advance(a)
      const partB = advance(b)
      if (partA === partB && partA !== undefined) continue
      load(a, partA)
      load(b, partB)
    } else if (endA) {
      load(a, advance(a))
    } else {
      load(b, advance(b))
    }
    if (a.done || b.done) return a.done ? b.done ? 0 : -1 : 1
  }
}

/** The rank of a map entry: its key's rank, U+0000, then its value's. */
const entryRank = (key: Rank, entry: Rank): Rank =>
  typeof key === "string" && typeof entry === "string"
    ? `${key}\u0000${entry}`
    : { id: -1, parts: [key, "\u0000", entry] }

/** Sorts values by rank, keeping the original order of equal ranks. */
const byRank = <A>(values: ReadonlyArray<A>, rankOf: (value: A) => Rank): Array<A> =>
  values
    .map((value) => ({ value, rank: rankOf(value) }))
    .sort((left, right) => compareRank(left.rank, right.rank))
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

/** An object whose copy is being filled. */
interface CopyFrame {
  readonly source: object
  readonly shell: object
  /** A set's entries, or a map's keys and values in turn; empty otherwise. */
  readonly entries: ReadonlyArray<unknown>
  /** The copies of `entries` made so far. */
  readonly copied: Array<unknown>
  /** The own keys, read once the entries are in the shell. */
  keys: ReadonlyArray<string | symbol> | undefined
  /** How many keys are defined on the shell. */
  index: number
}

/** What a copy returns for an object whose copy has only started. */
const started = Symbol("started")

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
 * - It keeps its own stack, so nesting depth is bounded by memory and the
 *   order never depends on the runtime's call stack. An object on no cycle
 *   is ranked once however often it is shared.
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
 * @throws {RangeError} Only one the engine raises while an object is inspected.
 *
 * @category transformations
 * @since 1.0.0
 */
export const sortCollections = <A>(value: A): A => {
  const dirty = dirtyObjects(value)
  if (dirty.size === 0) return value
  const copies = new Map<object, object>()
  const building = new Set<object>()
  const rank = ranker(building)
  const frames: Array<CopyFrame> = []

  /** The copy of `current`, or `started` after starting one. */
  const copy = (current: unknown): unknown => {
    if (!isObject(current) || !dirty.has(current)) return current
    const known = copies.get(current)
    if (known !== undefined) return known
    const shell = shellOf(current)
    copies.set(current, shell)
    building.add(shell)
    const entries: Array<unknown> = []
    if (current instanceof Set) {
      for (const entry of current) entries.push(entry)
    } else if (current instanceof Map) {
      for (const [key, entry] of current) entries.push(key, entry)
    }
    frames.push({ source: current, shell, entries, copied: [], keys: undefined, index: 0 })
    return started
  }

  /** Puts the copied entries into the shell in rank order. */
  const fill = ({ copied, shell, source }: CopyFrame): void => {
    if (source instanceof Set) {
      const target = shell as Set<unknown>
      for (const entry of byRank(copied, rank)) target.add(entry)
    } else if (source instanceof Map) {
      const target = shell as Map<unknown, unknown>
      const pairs: Array<readonly [unknown, unknown]> = []
      for (let index = 0; index < copied.length; index += 2) pairs.push([copied[index], copied[index + 1]])
      for (const [key, entry] of byRank(pairs, ([key, entry]) => entryRank(rank(key), rank(entry)))) {
        target.set(key, entry)
      }
    }
  }

  // The root reaches a collection, so its copy starts here.
  copy(value)
  for (let frame = frames[frames.length - 1]; frame !== undefined; frame = frames[frames.length - 1]) {
    if (frame.copied.length < frame.entries.length) {
      const copied = copy(frame.entries[frame.copied.length])
      if (copied !== started) frame.copied.push(copied)
      continue
    }
    if (frame.keys === undefined) {
      fill(frame)
      frame.keys = Reflect.ownKeys(frame.source)
    }
    const key = frame.keys[frame.index]
    if (key === undefined) {
      keepIntegrity(frame.source, frame.shell)
      building.delete(frame.shell)
      frames.pop()
      continue
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(frame.source, key)!
    if ("value" in descriptor) {
      const copied = copy(descriptor.value)
      if (copied === started) continue
      descriptor.value = copied
    }
    Reflect.defineProperty(frame.shell, key, descriptor)
    frame.index += 1
  }
  return copies.get(value as object) as A
}
