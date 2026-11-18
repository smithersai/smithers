/**
 * Test units: one test file of a `Vitest` target as the unit of work.
 *
 * A target that declares `units: "file"` is read as one unit per test file.
 * A unit's inputs are what its test file reaches (the TypeScript dependency
 * closure the {@link Resolver} computes, `new URL(path, import.meta.url)`
 * references included) plus the inputs every unit of its target shares: the
 * runner's config and what it reaches, and every declared input no test file
 * reaches. A change reruns only the units whose inputs hold a changed file.
 * A unit whose closure has an import nothing could follow is affected by
 * every change.
 *
 * Each unit runs as its own `vitest run <file>` and writes a blob of its
 * results and coverage. The target's own row merges every unit's blob and
 * judges the coverage thresholds, so they hold when only some files ran.
 *
 * The design, its prior art and its limits are in the test units concept
 * page of the `@smthrs/build` documentation.
 *
 * @since 1.0.0
 */

import * as Exec from "@smthrs/targets/Exec"
import * as Input from "@smthrs/targets/Input"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Target from "@smthrs/targets/Target"
import * as Vitest from "@smthrs/targets/Vitest"
import * as Data from "effect/Data"
import { Minimatch } from "minimatch"
import * as NodeFs from "node:fs/promises"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Affected from "./Affected.ts"
import { type CacheStore, openCache } from "./Cache.ts"
import * as ContainedProcess from "./internal/ContainedProcess.ts"
import { containedRelative } from "./internal/Path.ts"
import { byCodeUnit, posix, sha256Hex } from "./internal/Text.ts"
import type { PackageIndex } from "./PackageIndex.ts"
import * as Resolver from "./Resolver.ts"
import * as WorkspaceToolchain from "./WorkspaceToolchain.ts"

/**
 * The dependency-closure strategy units are computed with.
 *
 * @category constants
 * @since 1.0.0
 */
export const strategy = "typescript"

/**
 * The key format. Bump it when what a key covers changes.
 *
 * @category constants
 * @since 1.0.0
 */
export const keyFormat = "smthrs-test-unit/1"

/**
 * Units could not be read: the label names no single target, the target does
 * not declare `units: "file"`, or its `tests` are not files or globs.
 *
 * @category errors
 * @since 1.0.0
 */
export class UnitsError extends Data.TaggedError("smithers-build/UnitsError")<{
  readonly reason: "not_one_target" | "not_units" | "unsupported_input"
  readonly message: string
}> {
  constructor(reason: UnitsError["reason"], message: string) {
    super({ reason, message })
  }
}

/**
 * The label of one unit: its target's label, `#`, and the test file's path
 * from the target's package directory. A target name cannot hold `#`, so the
 * first `#` splits a unit label back into its two parts.
 *
 * @category labels
 * @since 1.0.0
 */
export const label = (target: string, packagePath: string, file: string): string => {
  const prefix = packagePath === "" ? "" : `${packagePath}/`
  return `${target}#${file.startsWith(prefix) ? file.slice(prefix.length) : `//${file}`}`
}

/**
 * Reads a unit label back into its target label and workspace-relative test
 * file, or `undefined` for a label that names no unit.
 *
 * @category labels
 * @since 1.0.0
 */
export const parse = (
  unit: string
): { readonly target: string; readonly packagePath: string; readonly file: string } | undefined => {
  const match = /^(\/\/([A-Za-z0-9._/-]*):[A-Za-z0-9._-]+)#(.+)$/.exec(unit)
  if (match === null) return undefined
  const [, target, packagePath, path] = match as unknown as [string, string, string, string]
  const file = path.startsWith("//") ? path.slice(2) : packagePath === "" ? path : `${packagePath}/${path}`
  return file === "" ? undefined : { target, packagePath, file }
}

/**
 * One file a unit reads, with the digest of its content.
 *
 * @category models
 * @since 1.0.0
 */
export interface ClosureFile {
  readonly path: string
  readonly digest: string
}

/**
 * An import the strategy could not follow to a file.
 *
 * @category models
 * @since 1.0.0
 */
export interface OpenImport {
  readonly from: string
  readonly specifier: string
}

/**
 * A dependency closure, in the shape `smithers-ci` contract 9 fixes.
 *
 * @category models
 * @since 1.0.0
 */
export interface Closure {
  readonly strategy: string
  readonly entries: ReadonlyArray<string>
  readonly files: ReadonlyArray<ClosureFile>
  readonly packages: ReadonlyArray<string>
  readonly unresolved: ReadonlyArray<OpenImport>
  readonly dynamic: ReadonlyArray<OpenImport>
}

/**
 * One test file as a unit of work.
 *
 * `reached` is what the test file reaches, itself included. `dependencies`
 * are the target's dependencies whose outputs the unit reads. `key` covers
 * everything the unit reads; see {@link discover}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Unit {
  readonly label: string
  readonly file: string
  readonly reached: ReadonlyArray<ClosureFile>
  readonly packages: ReadonlyArray<string>
  readonly unresolved: ReadonlyArray<OpenImport>
  readonly dynamic: ReadonlyArray<OpenImport>
  readonly dependencies: ReadonlyArray<string>
  readonly key: string
}

/**
 * Every unit of one target, with the inputs all of them share.
 *
 * @category models
 * @since 1.0.0
 */
export interface Units {
  readonly target: string
  readonly packagePath: string
  /** The target's attributes, with the workspace's package manager and runtime filled in. */
  readonly attrs: Vitest.Attrs
  readonly units: ReadonlyArray<Unit>
  /** Files every unit reads: the config's closure and each declared input no test file reaches. */
  readonly shared: ReadonlyArray<ClosureFile>
  /** The label of every dependency the target declares. */
  readonly dependencies: ReadonlyArray<string>
}

/** Whether a unit's closure names every file its test file can read. */
const complete = (unit: Unit): boolean => unit.unresolved.length === 0 && unit.dynamic.length === 0

/**
 * The unit's closure as a contract 9 document: what its test file reaches
 * and what every unit of its target reads, so a consumer that reads only
 * `files` selects correctly.
 *
 * @category accessors
 * @since 1.0.0
 */
export const closure = (units: Units, unit: Unit): Closure => {
  const files = new Map(units.shared.map((file) => [file.path, file.digest]))
  for (const file of unit.reached) files.set(file.path, file.digest)
  return {
    strategy,
    entries: [unit.file],
    files: [...files.keys()].sort(byCodeUnit).map((path) => ({ path, digest: files.get(path)! })),
    packages: unit.packages,
    unresolved: unit.unresolved,
    dynamic: unit.dynamic
  }
}

interface Reach {
  readonly files: ReadonlyArray<ClosureFile>
  readonly packages: ReadonlyArray<string>
  /** The packages imported for more than their manifest. */
  readonly built: ReadonlySet<string>
  readonly unresolved: ReadonlyArray<OpenImport>
  readonly dynamic: ReadonlyArray<OpenImport>
}

/** Everything one file reaches through the rows of one resolver walk. */
const reach = (rows: ReadonlyMap<string, Resolver.FileRow>, start: string): Reach => {
  const files = new Map<string, string>()
  const packages = new Set<string>()
  const built = new Set<string>()
  const unresolved = new Map<string, OpenImport>()
  const dynamic = new Map<string, OpenImport>()
  const queue = [start]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const row = rows.get(queue[cursor]!)!
    if (files.has(row.path)) continue
    files.set(row.path, row.digest)
    for (const edge of row.edges) {
      if (edge.status === "resolved-file") queue.push(edge.resolved!)
      else if (edge.status === "package") {
        packages.add(edge.packageName!)
        // A package's manifest is a global input. Importing it reads no build output.
        if (edge.specifier !== `${edge.packageName}/package.json`) built.add(edge.packageName!)
      } else if (edge.status !== "builtin") {
        const issue = { from: row.path, specifier: edge.specifier }
        const into = edge.status === "unresolved" ? unresolved : dynamic
        into.set(`${row.path}\u0000${edge.specifier}`, issue)
      }
    }
  }
  const sorted = (issues: ReadonlyMap<string, OpenImport>) =>
    [...issues.keys()].sort(byCodeUnit).map((key) => issues.get(key)!)
  return {
    files: [...files.keys()].sort(byCodeUnit).map((path) => ({ path, digest: files.get(path)! })),
    packages: [...packages].sort(byCodeUnit),
    built,
    unresolved: sorted(unresolved),
    dynamic: sorted(dynamic)
  }
}

/** Whether `path` is `directory` or lies under it; the workspace root holds every path. */
const under = (path: string, directory: string): boolean =>
  directory === "" || path === directory || path.startsWith(`${directory}/`)

/**
 * The workspace directory a package name resolves to from `packagePath`, or
 * `undefined` for a package installed from a registry or not installed.
 */
const workspacePackage = async (root: string, packagePath: string, name: string): Promise<string | undefined> => {
  const parts = packagePath.split("/").filter((part) => part !== "")
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    try {
      const real = await NodeFs.realpath(NodePath.join(root, ...parts.slice(0, depth), "node_modules", name))
      const relative = containedRelative(root, real)
      if (relative === undefined) return undefined
      const path = posix(relative)
      return path.split("/").includes("node_modules") ? undefined : path
    } catch {
      // Not installed at this level; the next one up may have it.
    }
  }
  return undefined
}

/**
 * Reads the units of one target that declares `units: "file"`.
 *
 * One resolver walk over every test file and the config gives the rows each
 * unit's closure is read from, so a file ten units reach is parsed once.
 * A unit's `key` is the digest of its label, the target's run settings, what
 * its test file reaches, the packages it imports by name, its open imports,
 * the shared inputs, and the dependencies it reads. It does not cover the
 * executed toolchain or a dependency's key, so on its own it does not make a
 * result safe to cache.
 *
 * @category discovery
 * @since 1.0.0
 */
export const discover = async (options: {
  readonly index: PackageIndex
  readonly target: string
  readonly cacheDirectory?: string | undefined
  readonly cache?: CacheStore | undefined
}): Promise<Units> => {
  const { index } = options
  const rows = index.resolve(options.target)
  const row = rows[0]
  if (row === undefined || rows.length !== 1) {
    throw new UnitsError("not_one_target", `${options.target} names ${rows.length} targets; units reads exactly one`)
  }
  const metadata = Target.metadata(row.target)
  const attrs = WorkspaceToolchain.fill(
    metadata.workspaceAttrs,
    metadata.attrs,
    WorkspaceToolchain.of(index.workspace)
  ) as Vitest.Attrs
  if (metadata.target !== "Vitest" || attrs.units !== "file") {
    throw new UnitsError("not_units", `${row.label} runs as one unit; a Vitest target declares units: "file" to split`)
  }
  const base = NodePath.join(index.root, row.packagePath)
  const anchored = (declared: ReadonlyArray<Input.Declared>, what: string, strict: boolean) =>
    declared.flatMap((source) => {
      if (source._tag === "File" || source._tag === "Glob") return [{ base, source }]
      if (strict) {
        throw new UnitsError("unsupported_input", `${row.label}: ${what} must be files or globs, not ${source._tag}`)
      }
      return []
    })
  const expand = (declared: ReadonlyArray<Input.Declared>, what: string, strict: boolean) =>
    Resolver.expandAnchoredSources({
      workspaceRoot: index.root,
      cacheDirectory: options.cacheDirectory,
      sources: anchored(declared, what, strict),
      requireFiles: strict
    })
  const tests = await expand(attrs.tests, "tests", true)
  const config = attrs.config === null ? undefined : Input.resolvePath(row.packagePath, attrs.config.path)
  const declared = new Set([...await expand(attrs.sources, "sources", false), ...tests])
  if (config !== undefined) declared.add(config)

  // The package's own tsconfig decides path aliases when it has one.
  const tsconfig = posix(NodePath.join(row.packagePath, "tsconfig.json"))
  const packageConfig = await NodeFs.access(NodePath.join(index.root, tsconfig)).then(() => true, () => false)
  const resolver = await Resolver.loadResolverConfig({
    workspaceRoot: index.root,
    tsconfig: packageConfig ? tsconfig : undefined
  })
  const walked = new Map<string, Resolver.FileRow>()
  await Resolver.computeClosure({
    config: resolver,
    entries: config === undefined ? tests : [...tests, config],
    cache: options.cache,
    references: true,
    rows: walked
  })
  const reaches = tests.map((file) => reach(walked, file))
  const universe = new Set(reaches.flatMap((reached) => reached.files.map((file) => file.path)))
  const configured = config === undefined ? undefined : reach(walked, config)

  const shared = new Map((configured?.files ?? []).map((file) => [file.path, file.digest]))
  const unreached = [...declared].filter((path) => !universe.has(path) && !shared.has(path)).sort(byCodeUnit)
  // A declared file that vanished since the expansion digests as the text "undefined".
  for (const file of await Input.digestFiles(index.root, unreached)) shared.set(file.path, String(file.digest))
  const sharedFiles = [...shared.keys()].sort(byCodeUnit).map((path) => ({ path, digest: shared.get(path)! }))
  const sharedDigest = sha256Hex(JSON.stringify(sharedFiles))

  const dependencies = metadata.dependencies.flatMap((dependency) => {
    const dependencyLabel = index.labelOf(dependency)
    return dependencyLabel === undefined ? [] : [dependencyLabel]
  }).sort(byCodeUnit)
  const dependencyPaths = new Map(dependencies.map((dependency) => [
    dependency,
    index.resolve(dependency)[0]!.packagePath
  ]))
  const packageDirectories = new Map<string, string | undefined>()
  for (const name of new Set(reaches.flatMap((reached) => reached.packages))) {
    packageDirectories.set(name, await workspacePackage(index.root, row.packagePath, name))
  }

  const settings = {
    config: config ?? null,
    coverage: attrs.coverage,
    cwd: attrs.cwd,
    env: Object.entries(attrs.env ?? {}).sort(([left], [right]) => byCodeUnit(left, right)),
    environment: attrs.environment,
    passWithNoTests: attrs.passWithNoTests
  }
  const units = tests.map((file, position): Unit => {
    const reached = reaches[position]!
    const unitLabel = label(row.label, row.packagePath, file)
    // A dependency is read through its outputs: a reached file in its package
    // that this target does not declare, or its package imported by name for
    // more than its manifest.
    const read = dependencies.filter((dependency) => {
      const directory = dependencyPaths.get(dependency)!
      return reached.files.some((entry) => under(entry.path, directory) && !declared.has(entry.path)) ||
        [...reached.built].some((name) => packageDirectories.get(name) === directory)
    })
    const unresolved = [...reached.unresolved, ...(configured?.unresolved ?? [])]
    const dynamic = [...reached.dynamic, ...(configured?.dynamic ?? [])]
    return {
      label: unitLabel,
      file,
      reached: reached.files,
      packages: reached.packages,
      unresolved,
      dynamic,
      dependencies: read,
      key: sha256Hex(JSON.stringify({
        format: keyFormat,
        label: unitLabel,
        settings,
        reached: reached.files,
        packages: reached.packages,
        unresolved,
        dynamic,
        shared: sharedDigest,
        dependencies: read
      }))
    }
  })
  return { target: row.label, packagePath: row.packagePath, attrs, units, shared: sharedFiles, dependencies }
}

/**
 * Why a change reaches one unit.
 *
 * `incomplete`: the unit's closure has an import nothing could follow.
 * `global`: a file every target depends on changed, such as a lockfile.
 * `shared`: a file every unit of the target reads changed. `closure`: a file
 * the test file reaches changed. `dependency`: a dependency the unit reads
 * is affected. `unattributed`: a changed file reaches the target and nothing
 * says which units read it.
 *
 * @category models
 * @since 1.0.0
 */
export type Reason =
  | { readonly kind: "incomplete" }
  | { readonly kind: "global" | "shared" | "closure" | "unattributed"; readonly file: string }
  | { readonly kind: "dependency"; readonly dependency: string }

/**
 * One change as the target sees it.
 *
 * `global` holds the files that select every target. `reaching` holds the
 * changed files that reach the target itself. `dependencies` maps each
 * affected dependency to the changed files that reach it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Change {
  readonly files: ReadonlyArray<string>
  readonly global: ReadonlyArray<string>
  readonly reaching: ReadonlyArray<string>
  readonly dependencies: ReadonlyMap<string, ReadonlyArray<string>>
}

/**
 * Reads one set of changed files as the target sees it, with the same
 * selection `smithers-build affected` makes for whole targets. One
 * difference: `affected` selects every target when the build tool's own
 * source changes. A unit that reads such a file by import is selected by it
 * as by any source file; a tool source no unit reads still selects them all.
 *
 * @category selection
 * @since 1.0.0
 */
export const changeOf = (
  index: PackageIndex,
  units: Units,
  files: ReadonlyArray<string>,
  options: { readonly cacheDirectory?: string } = {}
): Change => {
  const explain = (toolSources: boolean) =>
    Affected.select(index, [units.target, ...units.dependencies], files, { ...options, explain: true, toolSources })
  const strict = explain(true)
  const selection = strict.conservative ? explain(false) : strict
  if (selection.conservative) {
    return { files: selection.files, global: selection.globalInputs, reaching: [], dependencies: new Map() }
  }
  // The changed files that reach one selected label. For the target itself
  // only its own causes count, and not the one that selects a target with no
  // cache contract on any change: a unit's inputs are stated, so that cause
  // says nothing about a unit. A dependency keeps every cause.
  const reaching = (label: string, own: boolean): ReadonlyArray<string> => {
    const reached = new Set<string>()
    for (const position of selection.targets.find((root) => root.label === label)?.sources ?? []) {
      const source = selection.sources[position]!
      if (own && source.label !== label) continue
      for (const set of source.changes) {
        for (const change of selection.changeSets[set]!.map((entry) => selection.changes[entry]!)) {
          if (!own || change.kind !== "uncacheable") reached.add(change.file)
        }
      }
    }
    return [...reached].sort(byCodeUnit)
  }
  // What is left of a conservative selection is the build tool's own sources.
  // One a unit reads is that unit's source file. Any other reaches every unit.
  const read = new Set([
    ...units.shared.map((file) => file.path),
    ...units.units.flatMap((unit) => unit.reached.map((file) => file.path))
  ])
  return {
    files: selection.files,
    global: strict.conservative ? strict.globalInputs.filter((file) => !read.has(file)) : [],
    reaching: reaching(units.target, true),
    dependencies: new Map(units.dependencies.flatMap((dependency) => {
      const reached = reaching(dependency, false)
      return reached.length === 0 ? [] : [[dependency, reached] as const]
    }))
  }
}

/** Whether a path that may no longer exist is one the target's `tests` declare. */
const declaresTest = (units: Units): (path: string) => boolean => {
  const matchers = units.attrs.tests.map((source): (path: string) => boolean => {
    if (source._tag === "File") {
      const resolved = Input.resolvePath(units.packagePath, source.path)
      return (path) => path === resolved
    }
    const glob = source as Input.Glob
    const pattern = new Minimatch(Input.resolvePath(units.packagePath, glob.pattern), { dot: true })
    const excludes = glob.exclude.map((exclude) =>
      new Minimatch(Input.resolvePath(units.packagePath, exclude), { dot: true })
    )
    return (path) => pattern.match(path) && !excludes.some((exclude) => exclude.match(path))
  })
  return (path) => matchers.some((matches) => matches(path))
}

/**
 * The units one change reaches, in the target's order, each with every
 * reason.
 *
 * A changed file that reaches the target is read in this order. A shared
 * file reaches every unit. A file some test file reaches reaches those
 * units. A deleted test file reaches nothing: its unit is gone. A file that
 * reaches the target only through an affected dependency reaches the units
 * that read that dependency. Any other file reaches every unit, because
 * nothing says who reads it. A unit with an open import is reached by any
 * change at all.
 *
 * @category selection
 * @since 1.0.0
 */
export const select = (
  units: Units,
  change: Change
): ReadonlyArray<{ readonly unit: Unit; readonly reasons: ReadonlyArray<Reason> }> => {
  const every: Array<Reason> = change.global.map((file) => ({ kind: "global", file }))
  const shared = new Set(units.shared.map((file) => file.path))
  const readers = new Map<string, Array<Unit>>()
  for (const unit of units.units) {
    for (const file of unit.reached) {
      const reading = readers.get(file.path)
      if (reading === undefined) readers.set(file.path, [unit])
      else reading.push(unit)
    }
  }
  const viaDependency = new Set([...change.dependencies.values()].flat())
  const isTest = declaresTest(units)
  const own = new Map<Unit, Array<Reason>>()
  for (const file of change.reaching) {
    if (shared.has(file)) every.push({ kind: "shared", file })
    else if (readers.has(file)) {
      for (const unit of readers.get(file)!) own.set(unit, [...own.get(unit) ?? [], { kind: "closure", file }])
    } else if (!isTest(file) && !viaDependency.has(file)) every.push({ kind: "unattributed", file })
  }
  return units.units.flatMap((unit) => {
    const reasons: Array<Reason> = [
      ...(change.files.length > 0 && !complete(unit) ? [{ kind: "incomplete" } as const] : []),
      ...every,
      ...own.get(unit) ?? [],
      ...unit.dependencies.filter((dependency) => change.dependencies.has(dependency)).map((dependency) => ({
        kind: "dependency" as const,
        dependency
      }))
    ]
    return reasons.length === 0 ? [] : [{ unit, reasons }]
  })
}

/**
 * One execution of a unit, as a run record's attempt.
 *
 * @category models
 * @since 1.0.0
 */
export interface Attempt {
  readonly passed: boolean
  readonly durationMs: number
}

/**
 * One row of a run record: a unit's outcome, or the target's own row, which
 * is the merge of every unit's blob and the coverage verdict.
 *
 * @category models
 * @since 1.0.0
 */
export interface Result {
  readonly label: string
  readonly status: "ran" | "failed"
  readonly key: string
  readonly durationMs: number
  readonly target: string
  readonly attempts: ReadonlyArray<Attempt>
  readonly error?: string
}

/**
 * The record of one run of units, in the shape `smithers-ci` contract 1
 * fixes. `units` counts the units the target has; `results` holds the ones
 * that ran.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunRecord {
  readonly ok: boolean
  readonly counts: { readonly hit: number; readonly ran: number; readonly failed: number; readonly skipped: number }
  readonly results: ReadonlyArray<Result>
  readonly verb: "units"
  readonly pattern: string
  readonly jobs: number
  readonly durationMs: number
  readonly units: number
  /** Why the target's coverage was not judged, when it was not. */
  readonly coverage?: string
}

/** The last lines of a failed process's output, bounded for a result row. */
const tail = (text: string): string => {
  const trimmed = text.trimEnd()
  return trimmed.length > 4000 ? trimmed.slice(trimmed.length - 4000) : trimmed
}

/**
 * The directory the blobs of one target are kept in, workspace-relative.
 *
 * @category execution
 * @since 1.0.0
 */
export const blobDirectory = (cacheDirectory: string, target: string): string =>
  posix(NodePath.join(cacheDirectory, "test-units", sha256Hex(target).slice(0, 16)))

/**
 * Runs the selected units, each as its own `vitest run <file>`, at most
 * `jobs` at once, then judges the target.
 *
 * A unit passes when its run exits zero. Its blob is kept under its key, so
 * a unit that did not run still has the coverage of its last run with the
 * same inputs. A run first removes every blob no current key names. When
 * every unit of the target has a blob for its current key, the target's own
 * row merges them and judges the coverage thresholds. When some unit has
 * none, the record says coverage was not judged and names how many are
 * missing.
 *
 * @category execution
 * @since 1.0.0
 */
export const run = async (options: {
  readonly root: string
  readonly units: Units
  readonly selected: ReadonlyArray<Unit>
  readonly cacheDirectory: string
  readonly jobs: number
  readonly signal?: AbortSignal | undefined
  readonly log?: ((line: string) => void) | undefined
  readonly spawn?: typeof ContainedProcess.run | undefined
}): Promise<RunRecord> => {
  const { units } = options
  const { attrs } = units
  const spawn = options.spawn ?? ContainedProcess.run
  const log = options.log ?? (() => {})
  const started = performance.now()
  const cwd = NodePath.join(options.root, attrs.cwd)
  const blobs = NodePath.join(options.root, blobDirectory(options.cacheDirectory, units.target))
  await NodeFs.mkdir(blobs, { recursive: true })
  const blobOf = (unit: Unit) => NodePath.join(blobs, `${unit.key}.blob`)
  // The store holds one blob per unit: whatever no current key names goes,
  // so an edited or deleted test leaves no coverage behind and the store
  // does not grow with every edit.
  const keys = new Set(units.units.map((unit) => unit.key))
  for (const name of await NodeFs.readdir(blobs)) {
    if (!keys.has(name.slice(0, name.indexOf(".")))) {
      await NodeFs.rm(NodePath.join(blobs, name), { recursive: true, force: true })
    }
  }
  const environment = Exec.toolEnvironment(Runtime.environment(attrs.runtime, attrs.env), [])
  const vitest = (args: ReadonlyArray<string>) =>
    PackageManager.exec(PackageManager.under(attrs.packageManager, attrs.runtime), ["vitest", ...args])
  const execute = async (
    argv: ReadonlyArray<string>
  ): Promise<{ readonly passed: boolean; readonly output: string }> => {
    let output = ""
    const collect = (text: string) => {
      output += text
    }
    try {
      const code = await spawn({
        command: argv[0]!,
        args: argv.slice(1),
        cwd,
        environment,
        signal: options.signal,
        timeoutMs: attrs.timeoutMs,
        maxOutputBytes: 64 * 1024 * 1024,
        stdout: collect,
        stderr: collect
      })
      return { passed: code === 0, output }
    } catch (cause) {
      return { passed: false, output: `${output}\n${cause instanceof Error ? cause.message : String(cause)}` }
    }
  }
  const row = async (
    rowLabel: string,
    key: string,
    argv: ReadonlyArray<string>,
    produced: string | undefined
  ): Promise<Result> => {
    const before = performance.now()
    const outcome = await execute(argv)
    // A run that wrote no blob has nothing to merge, whatever it exited with.
    const written = produced === undefined || await NodeFs.access(produced).then(() => true, () => false)
    const passed = outcome.passed && written
    if (!passed && produced !== undefined) await NodeFs.rm(produced, { force: true })
    const durationMs = Math.round(performance.now() - before)
    log(`${passed ? "ran" : "failed"} ${rowLabel} ${durationMs}ms`)
    return {
      label: rowLabel,
      status: passed ? "ran" : "failed",
      key,
      durationMs,
      target: "Vitest",
      attempts: [{ passed, durationMs }],
      ...(passed ? {} : { error: tail(outcome.passed ? `${outcome.output}\nthe run wrote no blob` : outcome.output) })
    }
  }

  const results: Array<Result> = []
  const pending = [...options.selected]
  const worker = async (): Promise<void> => {
    for (let unit = pending.shift(); unit !== undefined; unit = pending.shift()) {
      const blob = blobOf(unit)
      // Each run reports into its own directory, so runs side by side never share one.
      const reports = NodePath.join(blobs, `${unit.key}.reports`)
      await NodeFs.rm(blob, { force: true })
      const file = posix(NodePath.relative(cwd, NodePath.join(options.root, unit.file)))
      results.push(await row(unit.label, unit.key, vitest(Vitest.unitArguments(attrs, { file, blob, reports })), blob))
      await NodeFs.rm(reports, { recursive: true, force: true })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.jobs, pending.length)) }, worker))
  const order = new Map(units.units.map((unit, position) => [unit.label, position]))
  results.sort((left, right) => order.get(left.label)! - order.get(right.label)!)

  // The target's own row: every unit's blob, merged, with thresholds judged.
  let missing = 0
  for (const unit of units.units) {
    if (!await NodeFs.access(blobOf(unit)).then(() => true, () => false)) missing += 1
  }
  let coverage: string | undefined
  if (results.some((result) => result.status === "failed")) coverage = "a unit failed"
  else if (missing > 0) coverage = `${missing} of ${units.units.length} units have no stored run for their inputs`
  else if (options.selected.length > 0) {
    results.push(
      await row(
        units.target,
        sha256Hex(JSON.stringify({ format: keyFormat, units: units.units.map((unit) => unit.key) })),
        vitest(Vitest.mergeArguments(attrs, blobs)),
        undefined
      )
    )
  }
  const count = (status: Result["status"]) => results.filter((result) => result.status === status).length
  return {
    ok: count("failed") === 0,
    counts: { hit: 0, ran: count("ran"), failed: count("failed"), skipped: 0 },
    results,
    verb: "units",
    pattern: units.target,
    jobs: options.jobs,
    durationMs: Math.round(performance.now() - started),
    units: units.units.length,
    ...(coverage === undefined ? {} : { coverage })
  }
}

/**
 * What `smithers-build units --list` prints: every unit of the target, with
 * whether the change selects it and why.
 *
 * @category models
 * @since 1.0.0
 */
export interface Listing {
  readonly target: string
  /** The changed files the selection was made from; empty with `--all`. */
  readonly files: ReadonlyArray<string>
  /** How many files every unit shares. */
  readonly shared: number
  readonly selected: number
  readonly units: ReadonlyArray<{
    readonly label: string
    readonly file: string
    readonly key: string
    readonly complete: boolean
    /** How many files the test file reaches, itself included. */
    readonly reached: number
    readonly selected: boolean
    readonly reasons: ReadonlyArray<Reason | { readonly kind: "all" }>
    readonly closure?: Closure
  }>
}

/**
 * Options of {@link command}, as `smithers-build units` reads them.
 *
 * @category models
 * @since 1.0.0
 */
export interface CommandOptions {
  readonly index: PackageIndex
  readonly label: string
  readonly cacheDirectory: string
  readonly base: string
  readonly head?: string | undefined
  readonly files?: ReadonlyArray<string> | undefined
  readonly all: boolean
  readonly list: boolean
  readonly closures: boolean
  readonly jobs?: number | undefined
  readonly resultsFile?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly log?: ((line: string) => void) | undefined
  readonly spawn?: typeof ContainedProcess.run | undefined
}

/**
 * `smithers-build units <label>`: lists or runs the units of one target that
 * a change reaches.
 *
 * The change is the same one `affected` reads: `--files`, or the Git
 * comparison of `--base` with `--head` or the working tree. `--all` selects
 * every unit. `--list` returns the {@link Listing}; otherwise the selected
 * units run and the {@link RunRecord} is returned and, with `--results-file`,
 * written there.
 *
 * @category commands
 * @since 1.0.0
 */
export const command = async (options: CommandOptions): Promise<Listing | RunRecord> => {
  const { index } = options
  const cache = await openCache({ workspaceRoot: index.root, cacheDirectory: options.cacheDirectory })
  let units: Units
  try {
    units = await discover({ index, target: options.label, cacheDirectory: options.cacheDirectory, cache })
  } finally {
    await cache.close()
  }
  const files = options.all ? [] : await Affected.changedPaths(index.root, {
    base: options.base,
    head: options.head,
    files: options.files,
    signal: options.signal,
    environment: options.environment
  })
  const reasons = new Map<Unit, ReadonlyArray<Reason | { readonly kind: "all" }>>(
    options.all
      ? units.units.map((unit) => [unit, [{ kind: "all" }]])
      : select(units, changeOf(index, units, files, { cacheDirectory: options.cacheDirectory })).map((
        selected
      ) => [selected.unit, selected.reasons])
  )
  if (options.list) {
    return {
      target: units.target,
      files,
      shared: units.shared.length,
      selected: reasons.size,
      units: units.units.map((unit) => ({
        label: unit.label,
        file: unit.file,
        key: unit.key,
        complete: complete(unit),
        reached: unit.reached.length,
        selected: reasons.has(unit),
        reasons: reasons.get(unit) ?? [],
        ...(options.closures ? { closure: closure(units, unit) } : {})
      }))
    }
  }
  const record = await run({
    root: index.root,
    units,
    selected: units.units.filter((unit) => reasons.has(unit)),
    cacheDirectory: options.cacheDirectory,
    jobs: options.jobs ?? Math.min(4, NodeOs.availableParallelism()),
    signal: options.signal,
    log: options.log,
    spawn: options.spawn
  })
  if (options.resultsFile !== undefined) {
    const path = NodePath.resolve(index.root, options.resultsFile)
    await NodeFs.mkdir(NodePath.dirname(path), { recursive: true })
    await NodeFs.writeFile(path, `${JSON.stringify(record, null, 2)}\n`)
  }
  return record
}
