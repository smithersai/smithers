/**
 * Inert JSON admission for plugin configuration and cache identity.
 *
 * Reflection is descriptor-only: accessors never execute, hostile proxies are
 * refused, and accepted values are detached before they are frozen.
 *
 * @private
 * @since 1.0.0-rc.0
 */

import * as BoundedJson from "@smthrs/canonical/BoundedJson"

/**
 * Strict JSON value accepted by the boundary.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export type Json = BoundedJson.Json

/**
 * Resource bounds for one admitted tree.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export type Limits = BoundedJson.StrictLimits

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

/**
 * Tests whether a string contains paired UTF-16 surrogate units.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const isWellFormedText = (value: string): boolean => value.isWellFormed()

const childPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`

const encodedStringBytes = (value: string): number => BoundedJson.encodedStringBytes(value)!

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

const remember = (value: ReadonlyArray<Json> | { readonly [key: string]: Json }): void => {
  const entries = new Map<string, Entry>()
  for (const [key, child] of Object.entries(value)) {
    entries.set(key, {
      keyBytes: Array.isArray(value) ? 0 : encodedStringBytes(key) + 1,
      totals: typeof child === "object" && child !== null ?
        snapshots.get(child)!.totals
        : scalarTotals(typeof child === "string" ? encodedStringBytes(child) : String(child).length)
    })
  }
  snapshots.set(value, { totals: total(entries), entries })
}

/**
 * Copies one strict JSON tree under explicit resource bounds.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const admit = (input: unknown, limits: Limits = defaultLimits): Admission => {
  const result = BoundedJson.admitStrict(input, limits, {
    ordinaryRecords: true,
    boundedText: true,
    onContainer: remember
  })
  return result.ok ? result : {
    ...result,
    path: boundedPath(result.path),
    complaint: result.complaint === "must be dense and have no extra properties"
      ? "must be a dense array with no extra properties" :
      result.complaint
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
