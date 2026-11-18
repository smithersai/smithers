/**
 * Expands `strategy.matrix` the way GitHub Actions does.
 *
 * @since 0.1.0
 */

import { isLiteralSecret } from "./Secrets.ts"
import { asScalar, isRecord } from "./Values.ts"

/**
 * The variants of a job, the variable names they set, and why a matrix could
 * not be read. A matrix with a problem has no variants.
 *
 * @category models
 * @since 0.1.0
 */
export interface Matrix {
  readonly variants: ReadonlyArray<Record<string, string>>
  readonly keys: ReadonlySet<string>
  readonly problem?: string
}

type Assignment = ReadonlyMap<string, string>

/** GitHub refuses a matrix with more variants than this. */
const maxVariants = 256

/**
 * A job with no matrix.
 *
 * @category constants
 * @since 0.1.0
 */
export const noMatrix: Matrix = { variants: [], keys: new Set() }

const unreadable = (problem: string): Matrix => ({ ...noMatrix, problem })

/** Adds one value under its name; a mapping's fields become `name.field`. */
const flatten = (name: string, value: unknown, into: Map<string, string>): boolean => {
  const scalar = asScalar(value)
  if (scalar !== undefined) {
    into.set(name, scalar)
    return !scalar.includes("${{")
  }
  return isRecord(value) && Object.entries(value).every(([key, item]) => flatten(`${name}.${key}`, item, into))
}

const readAssignment = (value: unknown): Assignment | undefined => {
  const into = new Map<string, string>()
  return isRecord(value) && Object.entries(value).every(([key, item]) => flatten(key, item, into)) ? into : undefined
}

const allRead = (items: ReadonlyArray<Assignment | undefined>): ReadonlyArray<Assignment> | undefined => {
  const read = items.filter((item) => item !== undefined)
  return read.length === items.length ? read : undefined
}

const readAssignments = (value: unknown): ReadonlyArray<Assignment> | undefined => {
  if (value === undefined) return []
  return Array.isArray(value) ? allRead(value.map(readAssignment)) : undefined
}

const readAxis = (name: string, values: unknown): ReadonlyArray<Assignment> | undefined => {
  if (!Array.isArray(values)) return undefined
  return allRead(values.map((value) => {
    const into = new Map<string, string>()
    return flatten(name, value, into) ? into : undefined
  }))
}

const matches = (variant: Assignment, filter: Assignment): boolean =>
  [...filter].every(([key, value]) => variant.get(key) === value)

const rootOf = (key: string): string => key.split(".")[0] as string

/** One top-level matrix value, with any nested fields, in a form that compares. */
const valueOf = (assignment: Assignment, root: string): string =>
  JSON.stringify([...assignment].filter(([key]) => rootOf(key) === root).sort(([a], [b]) => (a < b ? -1 : 1)))

/** True when adding `entry` changes no value `original` has. */
const fits = (original: Assignment, entry: Assignment): boolean =>
  [...entry.keys()].map(rootOf).every((root) => {
    const value = valueOf(original, root)
    return value === "[]" || value === valueOf(entry, root)
  })

const holdsSecret = (variant: Assignment): boolean =>
  [...variant].some(([key, value]) => isLiteralSecret(key.slice(key.lastIndexOf(".") + 1), value))

/**
 * Reads a matrix: every combination of its lists, less `exclude`, then
 * `include`. An `include` entry joins each original combination whose original
 * values it does not change, and is a new variant when it joins none.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const expandMatrix = (raw: unknown): Matrix => {
  if (raw === undefined) return noMatrix
  if (!isRecord(raw)) return unreadable("the matrix is computed when the workflow runs")
  const { exclude, include, ...lists } = raw
  const excluded = readAssignments(exclude)
  const included = readAssignments(include)
  if (excluded === undefined || included === undefined) return unreadable("include or exclude holds a computed value")

  let combinations: ReadonlyArray<Assignment> = Object.keys(lists).length === 0 ? [] : [new Map()]
  for (const [name, values] of Object.entries(lists)) {
    const axis = readAxis(name, values)
    if (axis === undefined) return unreadable(`${name} is not a list of plain values`)
    if (combinations.length * axis.length > maxVariants) return unreadable(`it has over ${maxVariants} variants`)
    combinations = combinations.flatMap((base) => axis.map((value) => new Map([...base, ...value])))
  }

  const originals = combinations.filter((variant) => !excluded.some((filter) => matches(variant, filter)))
  const merged = originals.map((variant) => new Map(variant))
  const added: Array<Assignment> = []
  for (const entry of included) {
    const joined = merged.filter((_, index) => fits(originals[index] as Assignment, entry))
    for (const variant of joined) for (const [key, value] of entry) variant.set(key, value)
    if (joined.length === 0) added.push(entry)
  }

  const variants = [...merged, ...added]
  if (variants.some(holdsSecret)) return unreadable("it holds a value named like a secret")
  return {
    variants: variants.map((variant) => Object.fromEntries(variant)),
    keys: new Set(variants.flatMap((variant) => [...variant.keys()]))
  }
}
