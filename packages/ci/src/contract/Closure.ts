/**
 * Contract 9: the dependency closure, one strategy per language.
 *
 * Given entry files, a strategy returns every file they reach. The TypeScript
 * strategy exists (`@smthrs/build-cli` `Resolver`); Zig, Rust, Go and the rest
 * each add one that returns this same shape. Affected selection, a test
 * file's cache key, and fast mode's graph distance all read it.
 *
 * A strategy never guesses. An import it cannot follow goes in `unresolved`
 * or `dynamic`, and a consumer treats a closure with either as affected by
 * every change.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * One file in a closure, with the digest of its content.
 *
 * @category models
 * @since 0.1.0
 */
export const ClosureFile = Schema.Struct({
  path: Schema.NonEmptyString,
  digest: Schema.NonEmptyString
})

/**
 * A decoded `ClosureFile`.
 *
 * @category models
 * @since 0.1.0
 */
export type ClosureFile = typeof ClosureFile.Type

/**
 * An import a strategy could not follow to a file.
 *
 * @category models
 * @since 0.1.0
 */
export const OpenImport = Schema.Struct({
  from: Schema.NonEmptyString,
  specifier: Schema.String
})

/**
 * A decoded `OpenImport`.
 *
 * @category models
 * @since 0.1.0
 */
export type OpenImport = typeof OpenImport.Type

/**
 * Everything a set of entry files reaches.
 *
 * @category models
 * @since 0.1.0
 */
export const Closure = Schema.Struct({
  strategy: Schema.NonEmptyString,
  entries: Schema.Array(Schema.NonEmptyString),
  files: Schema.Array(ClosureFile),
  packages: Schema.Array(Schema.String),
  unresolved: Schema.Array(OpenImport),
  dynamic: Schema.Array(OpenImport)
})

/**
 * A decoded `Closure`.
 *
 * @category models
 * @since 0.1.0
 */
export type Closure = typeof Closure.Type

/**
 * True when the closure names every file its entries can read, so a change
 * outside `files` cannot affect them.
 *
 * @category accessors
 * @since 0.1.0
 */
export const isComplete = (closure: Closure): boolean => closure.unresolved.length === 0 && closure.dynamic.length === 0

/**
 * True when a change to `changed` can affect the closure's entries. An
 * incomplete closure is affected by every change.
 *
 * @category accessors
 * @since 0.1.0
 */
export const isAffectedBy = (closure: Closure, changed: ReadonlyArray<string>): boolean => {
  if (!isComplete(closure)) return true
  const reached = new Set(closure.files.map((file) => file.path))
  return changed.some((path) => reached.has(path))
}
