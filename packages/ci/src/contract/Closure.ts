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
 * Everything a set of entries reaches. An entry is a file, or the name of a
 * build step where the language's build tool owns the graph, as in Zig.
 * `directories` are read whole: a file added under one affects the entries.
 * `packages` names what was reached outside the repository, the toolchain's
 * own library included, so a cache key built from a closure includes it.
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
  dynamic: Schema.Array(OpenImport),
  directories: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
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
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const isComplete = (closure: Closure): boolean => closure.unresolved.length === 0 && closure.dynamic.length === 0

/**
 * True when a change to `changed` can affect the closure's entries: a file
 * it reaches changed, or any file under a directory it reads whole. An
 * incomplete closure is affected by every change.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const isAffectedBy = (closure: Closure, changed: ReadonlyArray<string>): boolean => {
  if (!isComplete(closure)) return true
  const reached = new Set(closure.files.map((file) => file.path))
  const under = (closure.directories ?? []).map((directory) => directory.endsWith("/") ? directory : `${directory}/`)
  return changed.some((path) => reached.has(path) || under.some((directory) => path.startsWith(directory)))
}
