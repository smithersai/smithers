/**
 * Inert JSON admission for plugin configuration and cache identity.
 *
 * Reflection is descriptor-only: accessors never execute, hostile proxies are
 * refused, and accepted values are detached before they are frozen.
 *
 * @private
 * @since 1.0.0-rc.0
 */

/**
 * Strict JSON value accepted by the boundary.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/**
 * Resource bounds for one admitted tree.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export interface Limits {
  readonly maxBytes: number
  readonly maxDepth: number
  readonly maxMembers: number
  readonly maxNodes: number
  readonly maxStringBytes: number
  readonly maxKeyBytes: number
}

/**
 * Successful admission.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export interface AdmissionSuccess {
  readonly ok: true
  readonly value: Json
}

/**
 * Refusal with a stable value path.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export interface AdmissionFailure {
  readonly ok: false
  readonly path: string
  readonly complaint: string
}

/**
 * Result of inert JSON admission.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export type Admission = AdmissionSuccess | AdmissionFailure

/**
 * Default configuration bounds.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const defaultLimits: Limits = Object.freeze({
  maxBytes: 1024 * 1024,
  maxDepth: 64,
  maxMembers: 4_096,
  maxNodes: 8_192,
  maxStringBytes: 64 * 1024,
  maxKeyBytes: 1_024
})

const encoder = new TextEncoder()
const dangerousKeys = new Set(["__proto__", "constructor", "prototype"])

/**
 * Tests whether a string contains paired UTF-16 surrogate units.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const isWellFormedText = (value: string): boolean => value.isWellFormed()

const childPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`

const encodedStringBytes = (value: string): number => encoder.encode(JSON.stringify(value)).byteLength

// Paths contain only well-formed text and JSON-escaped keys. Count their JSON
// bytes without encoding the whole path, reserving quotes and a truncation marker.
const boundedPath = (path: string): string => {
  let bytes = 2 + 3
  let prefix = ""
  for (const character of path) {
    const point = character.codePointAt(0)!
    bytes += character === "\"" || character === "\\"
      ? 2
      : point <= 0x7f
      ? 1
      : point <= 0x7ff
      ? 2
      : point <= 0xffff
      ? 3
      : 4
    if (bytes > 192) return `${prefix}...`
    prefix += character
  }
  return path
}

interface Totals {
  bytes: number
  members: number
  nodes: number
  depth: number
}

interface Entry {
  readonly keyBytes: number
  readonly totals: Totals
}

interface Snapshot {
  readonly totals: Totals
  readonly entries: Map<string, Entry>
}

// Only detached containers constructed here enter this map. Mutable caller
// objects and Object.freeze alone never establish admission.
const snapshots = new WeakMap<object, Snapshot>()

const scalarTotals = (bytes: number): Totals => ({ bytes, members: 0, nodes: 1, depth: 0 })

const total = (entries: ReadonlyMap<string, Entry>): Totals => {
  const totals: Totals = { bytes: 2 + Math.max(0, entries.size - 1), members: entries.size, nodes: 1, depth: 1 }
  for (const entry of entries.values()) {
    totals.bytes += entry.keyBytes + entry.totals.bytes
    totals.members += entry.totals.members
    totals.nodes += entry.totals.nodes
    totals.depth = Math.max(totals.depth, 1 + entry.totals.depth)
  }
  return totals
}

interface Frame {
  readonly input: unknown
  readonly path: string
  readonly depth: number
  readonly assign: (value: Json, totals: Totals) => void
}

/**
 * Copies one strict JSON tree under explicit resource bounds.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const admit = (input: unknown, limits: Limits = defaultLimits): Admission => {
  let root: Json = null
  let bytes = 0
  let members = 0
  let nodes = 0
  const seen = new WeakSet<object>()
  const containers: Array<ReadonlyArray<Json> | { readonly [key: string]: Json }> = []
  const frames: Array<Frame> = [{ input, path: "$", depth: 0, assign: (value) => root = value }]
  let activePath = "$"
  const fail = (path: string, complaint: string): AdmissionFailure => ({
    ok: false,
    path: boundedPath(path),
    complaint
  })
  const addBytes = (count: number, path: string): AdmissionFailure | undefined => {
    bytes += count
    return bytes > limits.maxBytes ? fail(path, `exceeds the ${limits.maxBytes}-byte limit`) : undefined
  }

  try {
    while (frames.length > 0) {
      const frame = frames.pop()!
      activePath = frame.path
      nodes += 1
      if (nodes > limits.maxNodes) return fail(frame.path, `exceeds the ${limits.maxNodes}-node limit`)

      const value = frame.input
      if (value === null) {
        const exceeded = addBytes(4, frame.path)
        if (exceeded) return exceeded
        frame.assign(null, scalarTotals(4))
        continue
      }
      if (typeof value === "boolean") {
        const exceeded = addBytes(value ? 4 : 5, frame.path)
        if (exceeded) return exceeded
        frame.assign(value, scalarTotals(value ? 4 : 5))
        continue
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return fail(frame.path, "must be a finite JSON number")
        const numberBytes = encoder.encode(JSON.stringify(value)).byteLength
        const exceeded = addBytes(numberBytes, frame.path)
        if (exceeded) return exceeded
        frame.assign(value, scalarTotals(numberBytes))
        continue
      }
      if (typeof value === "string") {
        // Every UTF-16 unit requires at least one encoded byte.
        if (value.length > limits.maxStringBytes) {
          return fail(frame.path, `exceeds the ${limits.maxStringBytes}-byte string limit`)
        }
        if (!isWellFormedText(value)) return fail(frame.path, "contains an unpaired UTF-16 surrogate")
        const stringBytes = encodedStringBytes(value)
        if (stringBytes > limits.maxStringBytes) {
          return fail(frame.path, `exceeds the ${limits.maxStringBytes}-byte string limit`)
        }
        const exceeded = addBytes(stringBytes, frame.path)
        if (exceeded) return exceeded
        frame.assign(value, scalarTotals(stringBytes))
        continue
      }
      if (typeof value !== "object") return fail(frame.path, "must contain only JSON values")
      if (frame.depth >= limits.maxDepth) return fail(frame.path, `exceeds the depth limit of ${limits.maxDepth}`)
      if (seen.has(value)) return fail(frame.path, "contains a cycle or repeated object reference")
      seen.add(value)

      const keys = Reflect.ownKeys(value)
      const prototype = Object.getPrototypeOf(value)
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype) return fail(frame.path, "must be an ordinary array")
        const length = value.length
        if (!Number.isSafeInteger(length)) return fail(frame.path, "has an invalid array length")
        members += length
        if (members > limits.maxMembers) return fail(frame.path, `exceeds the ${limits.maxMembers}-member limit`)
        if (keys.length !== length + 1 || !keys.includes("length")) {
          return fail(frame.path, "must be a dense array with no extra properties")
        }
        const output: Array<Json> = new Array(length)
        const metadata: Snapshot = { totals: scalarTotals(0), entries: new Map() }
        snapshots.set(output, metadata)
        frame.assign(output, metadata.totals)
        containers.push(output)
        const exceeded = addBytes(2 + Math.max(0, length - 1), frame.path)
        if (exceeded) return exceeded
        for (let index = length - 1; index >= 0; index--) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            return fail(`${frame.path}[${index}]`, "must be an enumerable data property")
          }
          frames.push({
            input: descriptor.value,
            path: `${frame.path}[${index}]`,
            depth: frame.depth + 1,
            assign: (item, totals) => {
              output[index] = item
              metadata.entries.set(String(index), { keyBytes: 0, totals })
            }
          })
        }
        continue
      }

      if (prototype !== Object.prototype && prototype !== null) {
        return fail(frame.path, "must be an ordinary record")
      }
      if (keys.some((key) => typeof key === "symbol")) return fail(frame.path, "must not contain symbol keys")
      const stringKeys = keys as Array<string>
      members += stringKeys.length
      if (members > limits.maxMembers) return fail(frame.path, `exceeds the ${limits.maxMembers}-member limit`)
      const output: Record<string, Json> = {}
      const metadata: Snapshot = { totals: scalarTotals(0), entries: new Map() }
      snapshots.set(output, metadata)
      frame.assign(output, metadata.totals)
      containers.push(output)
      let structuralBytes = 2 + Math.max(0, stringKeys.length - 1)
      const children: Array<
        { readonly key: string; readonly keyBytes: number; readonly value: unknown; readonly path: string }
      > = []
      for (let index = 0; index < stringKeys.length; index++) {
        const key = stringKeys[index]!
        if (key.length > limits.maxKeyBytes) {
          return fail(`${frame.path}[key:${index}]`, `exceeds the ${limits.maxKeyBytes}-byte key limit`)
        }
        if (!isWellFormedText(key)) return fail(`${frame.path}[key:${index}]`, "has an ill-formed property name")
        const keyBytes = encodedStringBytes(key)
        if (keyBytes > limits.maxKeyBytes) {
          return fail(`${frame.path}[key:${index}]`, `exceeds the ${limits.maxKeyBytes}-byte key limit`)
        }
        const path = childPath(frame.path, key)
        if (dangerousKeys.has(key)) return fail(path, "uses a reserved property name")
        structuralBytes += keyBytes + 1
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          return fail(path, "must be an enumerable data property")
        }
        children.push({ key, keyBytes: keyBytes + 1, value: descriptor.value, path })
      }
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index]!
        frames.push({
          input: child.value,
          path: child.path,
          depth: frame.depth + 1,
          assign: (item, totals) => {
            metadata.entries.set(child.key, { keyBytes: child.keyBytes, totals })
            Object.defineProperty(output, child.key, {
              value: item,
              enumerable: true,
              configurable: true,
              writable: true
            })
          }
        })
      }
      const exceeded = addBytes(structuralBytes, frame.path)
      if (exceeded) return exceeded
    }

    for (let index = containers.length - 1; index >= 0; index--) {
      const container = containers[index]!
      const metadata = snapshots.get(container)!
      Object.assign(metadata.totals, total(metadata.entries))
      Object.freeze(container)
    }
    return { ok: true, value: root }
  } catch {
    return fail(activePath, "could not be inspected without executing user code")
  }
}

/**
 * Admits only a JSON record at the root.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const record = (
  input: unknown,
  limits: Limits = defaultLimits
): AdmissionSuccess | AdmissionFailure => {
  const admitted = admit(input, limits)
  return admitted.ok && (admitted.value === null || Array.isArray(admitted.value) || typeof admitted.value !== "object")
    ? { ok: false, path: "$", complaint: "must be a JSON record" }
    : admitted
}

/**
 * Merges two independently admitted records, retaining unchanged subtrees.
 * Both operands must come from successful admission, and the patch must be a
 * fresh copy: their trees must be disjoint. Each output branch then comes from
 * at most one location in either tree, preserving the no-repeated-reference
 * invariant without walking retained subtrees. Limits apply to the result.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const mergeRecords = (
  base: { readonly [key: string]: Json },
  patch: { readonly [key: string]: Json },
  limits: Limits = defaultLimits
): Admission => {
  const merge = (
    left: { readonly [key: string]: Json },
    right: { readonly [key: string]: Json },
    path: string
  ): Admission => {
    const entries = new Map(snapshots.get(left)!.entries)
    const result = { ...left }
    for (const [key, entry] of snapshots.get(right)!.entries) {
      const previous = left[key]
      const next = right[key]!
      if (
        typeof previous === "object" && previous !== null && !Array.isArray(previous) &&
        typeof next === "object" && next !== null && !Array.isArray(next)
      ) {
        const merged = merge(
          previous as { readonly [key: string]: Json },
          next as { readonly [key: string]: Json },
          childPath(path, key)
        )
        if (!merged.ok) return merged
        result[key] = merged.value
        entries.set(key, { keyBytes: entry.keyBytes, totals: snapshots.get(merged.value as object)!.totals })
      } else {
        result[key] = next
        entries.set(key, entry)
      }
    }
    const totals = total(entries)
    const complaint = totals.members > limits.maxMembers ?
      `exceeds the ${limits.maxMembers}-member limit`
      : totals.nodes > limits.maxNodes ?
      `exceeds the ${limits.maxNodes}-node limit`
      : totals.bytes > limits.maxBytes ?
      `exceeds the ${limits.maxBytes}-byte limit`
      : totals.depth > limits.maxDepth ?
      `exceeds the depth limit of ${limits.maxDepth}`
      : undefined
    if (complaint !== undefined) return { ok: false, path: boundedPath(path), complaint }
    Object.freeze(result)
    snapshots.set(result, { totals, entries })
    return { ok: true, value: result }
  }
  return merge(base, patch, "$")
}
