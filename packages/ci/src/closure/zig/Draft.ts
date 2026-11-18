/**
 * A closure being put together: where each reported input belongs.
 *
 * An input is a file of the repository, a directory of it that is read
 * whole, part of a package, or something that cannot be followed. Nothing is left out: an input this code cannot place is
 * written to `unresolved` or `dynamic`, which makes the closure affected by
 * every change.
 *
 * @since 0.1.0
 */

import type * as Path from "effect/Path"
import type { Closure, ClosureFile, OpenImport } from "../../contract/Closure.ts"
import type * as Graph from "./Graph.ts"
import type * as Manifest from "./Manifest.ts"
import type * as Protocol from "./Protocol.ts"

/**
 * The parts of a closure before its files are read and digested.
 *
 * @category models
 * @since 0.1.0
 */
export interface Draft {
  readonly entry: string
  readonly files: Set<string>
  /** Directories read whole. */
  readonly directories: Set<string>
  readonly packages: Set<string>
  readonly unresolved: Array<OpenImport>
  readonly dynamic: Array<OpenImport>
}

/**
 * What placing an input needs to know about the project.
 *
 * @category models
 * @since 0.1.0
 */
export interface Place {
  /** The repository's absolute path. */
  readonly root: string
  /** The absolute path of the directory holding `build.zig`. */
  readonly directory: string
  /** The Zig release, such as `0.17.1`. */
  readonly version: string
  readonly path: Path.Path
}

/**
 * One reported input: where its path starts, the path, and whether it is a
 * directory.
 *
 * @category models
 * @since 0.1.0
 */
export interface Located {
  readonly prefix: Manifest.Prefix
  readonly path: string
  readonly directory: boolean
}

/**
 * An empty draft for one entry.
 *
 * @throws {never}
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (entry: string): Draft => ({
  entry,
  files: new Set(),
  directories: new Set(),
  packages: new Set(),
  unresolved: [],
  dynamic: []
})

/**
 * True for a step whose inputs only the compiler knows.
 *
 * @throws {never}
 *
 * @category accessors
 * @since 0.1.0
 */
export const compiles = (step: Graph.Step): boolean => step.kind === "compile" || step.kind === "translate_c"

/**
 * The output directory a cache path such as `o/<digest>/name` or
 * `c/<digest>` is in.
 *
 * @throws {never}
 *
 * @category accessors
 * @since 0.1.0
 */
export const outputOf = (path: string): string | undefined => /(?:^|\/)[oc]\/([0-9a-f]{32})(?:\/|$)/.exec(path)?.[1]

/**
 * The inputs of the manifest that belongs to a cache path, when there is one.
 *
 * @param manifests - Every cache manifest, by output directory.
 * @param path - A path such as `o/<digest>/name`, or `undefined`.
 * @throws {never}
 *
 * @category accessors
 * @since 0.1.0
 */
export const listed = (
  manifests: ReadonlyMap<string, ReadonlyArray<Manifest.Input>>,
  path: string | undefined
): ReadonlyArray<Manifest.Input> | undefined => manifests.get(outputOf(path ?? "") ?? "")

/**
 * Adds compile errors to a draft's `unresolved`, each against the file it
 * points at, or against `from` when it points at none.
 *
 * @throws {never}
 *
 * @category combinators
 * @since 0.1.0
 */
export const report = (into: Draft, from: string, problems: ReadonlyArray<Protocol.Problem>): void => {
  for (const problem of problems) into.unresolved.push({ from: problem.file ?? from, specifier: problem.message })
}

/**
 * Places one input in a draft.
 *
 * - Under the repository: a file, or a directory that is read whole, since a
 *   file added to it later changes what the step reads.
 * - The repository's own root, read whole: `dynamic`, since every change is
 *   under it.
 * - In Zig's own library directory: the package `zig@<version>`.
 * - A fetched package (`p/<name>/` in the global cache): the package `<name>`.
 * - Anywhere else on the machine: the package `host`.
 * - In a cache directory: nothing, because another step or the toolchain
 *   derived it from inputs that are placed themselves.
 * - With a path prefix Zig 0.17 does not define: `unresolved`.
 *
 * @param place - The project.
 * @param into - The draft to add to.
 * @param from - Who read the input: a step's name, `build.zig` or an entry file.
 * @param input - The input.
 * @throws {never}
 *
 * @category combinators
 * @since 0.1.0
 */
export const admit = (place: Place, into: Draft, from: string, input: Located): void => {
  switch (input.prefix) {
    case "zig-lib":
      into.packages.add(`zig@${place.version}`)
      return
    case "global-cache": {
      const fetched = /^p\/([^/]+)\//.exec(input.path)?.[1]
      if (fetched !== undefined) into.packages.add(fetched)
      return
    }
    case "local-cache":
      return
    case "unknown":
      into.unresolved.push({ from, specifier: input.path })
      return
    default: {
      const relative = place.path.relative(place.root, place.path.resolve(place.directory, input.path))
      if (relative.startsWith("..") || place.path.isAbsolute(relative)) into.packages.add("host")
      else if (relative === "") into.dynamic.push({ from, specifier: "the whole repository" })
      else if (input.directory) into.directories.add(relative)
      else into.files.add(relative)
    }
  }
}

/**
 * Adds what the build server said about one step.
 *
 * A compile step must have been built and must have left the list of files it
 * read; if not, the reason goes to `unresolved`. A step that failed puts each
 * compile error there, against the file the error points at.
 *
 * @param place - The project.
 * @param into - The draft to add to.
 * @param step - The step.
 * @param result - The server's report for the step, when it built it.
 * @param manifests - Every cache manifest, by output directory.
 * @throws {never}
 *
 * @category combinators
 * @since 0.1.0
 */
export const settle = (
  place: Place,
  into: Draft,
  step: Graph.Step,
  result: Protocol.StepResult | undefined,
  manifests: ReadonlyMap<string, ReadonlyArray<Manifest.Input>>
): void => {
  if (result === undefined) {
    if (compiles(step)) into.unresolved.push({ from: step.name, specifier: "the step was not built" })
    return
  }
  if (result.status !== "success") {
    if (result.problems.length === 0) {
      into.unresolved.push({ from: step.name, specifier: `the step ended as ${result.status}` })
    }
    report(into, step.name, result.problems)
    return
  }
  const lists = result.outputs.map((output) => listed(manifests, output.path)).filter((list) => list !== undefined)
  if (compiles(step) && lists.length === 0) {
    into.unresolved.push({ from: step.name, specifier: "the compiler left no list of the files it read" })
  }
  for (const input of lists.flat()) admit(place, into, step.name, input)
}

const order = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const distinct = (items: ReadonlyArray<OpenImport>): ReadonlyArray<OpenImport> =>
  [...new Map(items.map((item) => [`${item.from}\n${item.specifier}`, item])).values()]
    .sort((left, right) => order(left.from, right.from) || order(left.specifier, right.specifier))

/**
 * Writes the closure of a draft.
 *
 * @param strategy - The strategy's name.
 * @param draft - The draft.
 * @param digests - The content digest of each file that could be read. A file
 * with no digest goes to `unresolved`.
 * @returns The closure, with files, directories, packages and open imports
 * sorted. `directories` is present only when there is one.
 * @throws {never}
 *
 * @category constructors
 * @since 0.1.0
 */
export const close = (strategy: string, draft: Draft, digests: ReadonlyMap<string, string>): Closure => {
  const files: Array<ClosureFile> = []
  const unread: Array<OpenImport> = []
  for (const path of [...draft.files].sort(order)) {
    const digest = digests.get(path)
    if (digest === undefined) unread.push({ from: path, specifier: "the file cannot be read" })
    else files.push({ path, digest })
  }
  return {
    strategy,
    entries: [draft.entry],
    files,
    packages: [...draft.packages].sort(order),
    unresolved: distinct([...draft.unresolved, ...unread]),
    dynamic: distinct(draft.dynamic),
    ...(draft.directories.size === 0 ? {} : { directories: [...draft.directories].sort(order) })
  }
}
