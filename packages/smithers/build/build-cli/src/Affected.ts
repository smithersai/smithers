/** Conservative changed-file selection, including reverse target dependencies.
 * @since 0.1.0
 */

import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import * as Data from "effect/Data"
import { Minimatch } from "minimatch"
import * as Fs from "node:fs"
import * as Path from "node:path"
import * as ContainedProcess from "./internal/ContainedProcess.ts"
import { inputPackage } from "./internal/InputPackage.ts"
import { managerFilesOf, nodeModulesDirectories } from "./internal/PackagePlanner.ts"
import { contains } from "./internal/Path.ts"
import * as RulePolicy from "./internal/RulePolicy.ts"
import type { PackageIndex } from "./PackageIndex.ts"
import { productionSourceRoots } from "./Planner.ts"

/** Affected discovery refused a git result or could not finish within its bound.
 * @category errors
 * @since 1.0.0-rc.0
 */
export class AffectedGitError extends Data.TaggedError("smithers-build/AffectedGitError")<{
  readonly code: ContainedProcess.ProcessError["code"] | "nonzero_exit" | "invalid_timeout"
  readonly args: ReadonlyArray<string>
  readonly message: string
  readonly cause?: unknown
}> {
  constructor(code: AffectedGitError["code"], args: ReadonlyArray<string>, message: string, cause?: unknown) {
    super({ code, args: [...args], message, ...(cause === undefined ? {} : { cause }) })
  }
}

/** Collects changed paths from explicit inputs or a verified Git comparison.
 * The optional process runner admits bounded host execution and fault injection.
 * @category querying
 * @since 0.1.0
 */
export const changedPaths = async (root: string, options: {
  readonly base: string
  readonly head?: string | undefined
  readonly files?: ReadonlyArray<string> | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
}, run: typeof ContainedProcess.run = ContainedProcess.run): Promise<ReadonlyArray<string>> => {
  if (options.signal?.aborted) {
    throw new AffectedGitError("cancelled", [], "affected discovery cancelled", options.signal.reason)
  }
  if (options.files !== undefined) return [...new Set(options.files)].sort()
  const timeoutMs = options.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new AffectedGitError("invalid_timeout", [], "git timeout must be an integer from 1 to 86400000ms")
  }
  const git = async (args: ReadonlyArray<string>): Promise<string> => {
    let stdout = ""
    let stderr = ""
    let code: number
    try {
      code = await run({
        command: "git",
        args,
        cwd: root,
        signal: options.signal,
        environment: options.environment,
        timeoutMs,
        maxOutputBytes: 16 * 1024 * 1024,
        fatalUtf8: true,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        }
      })
    } catch (cause) {
      throw new AffectedGitError(
        cause instanceof ContainedProcess.ProcessError ? cause.code : "process_failed",
        args,
        `git ${args[0]} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause
      )
    }
    if (code !== 0) {
      throw new AffectedGitError("nonzero_exit", args, `git ${args[0]} exited ${code}: ${stderr.trim()}`, {
        exitCode: code,
        stderr
      })
    }
    return stdout
  }
  const gitPaths = async (args: ReadonlyArray<string>) => (await git(args)).split("\0").filter(Boolean)
  // Resolve user revisions before passing them to diff; a leading dash cannot become an option.
  const revision = async (ref: string) =>
    (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim()
  const base = await revision(options.base)
  const paths = options.head === undefined
    ? [
      ...await gitPaths(["diff", "--relative", "--name-only", "--no-renames", "-z", base, "--"]),
      ...await gitPaths(["ls-files", "--others", "--exclude-standard", "-z"])
    ]
    : await gitPaths([
      "diff",
      "--relative",
      "--name-only",
      "--no-renames",
      "-z",
      base,
      await revision(options.head),
      "--"
    ])
  return [...new Set(paths)].sort()
}

const globalPath = (path: string): boolean =>
  !path.includes("/") || path.startsWith(".smithers/") || Input.isDeclarationFileName(Path.posix.basename(path)) ||
  /(^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|flake\.lock|go\.sum|[^/]*\.lock|package\.json|tsconfig[^/]*\.json|\.npmrc|\.yarnrc[^/]*|\.gitignore)$/
    .test(path)

const ambientInput = (input: Input.Declared): boolean => input._tag === "GitDiff" || input._tag === "PnpmWorkspace"

interface ReasonDetail {
  readonly file: string
  readonly kind:
    | "global-input"
    | "unknown-input"
    | "ambient-input"
    | "uncacheable"
    | "sandbox-input"
    | "indirect-input"
    | "package"
    | "declared-input"
    | "empty"
  readonly label?: string
  readonly rule?: string
  readonly input?: Input.Declared
  readonly dependencyPath?: ReadonlyArray<string>
  readonly readPath?: string
}

const compileInput = (
  input: Input.Declared,
  packagePath: string,
  glob: (pattern: string) => Minimatch
): (path: string) => boolean => {
  switch (input._tag) {
    case "File": {
      const resolved = Input.resolvePath(packagePath, input.path)
      return (path) => resolved === path
    }
    case "Glob": {
      const pattern = glob(Input.resolvePath(packagePath, input.pattern))
      const excludes = input.exclude.map((exclude) => glob(Input.resolvePath(packagePath, exclude)))
      return (path) => pattern.match(path) && !excludes.some((exclude) => exclude.match(path))
    }
    // An install's identity is its manifest and lockfiles; the installed tree
    // is ignored state and never a changed path.
    case "NodeModules": {
      const paths = Input.nodeModulesPaths(packagePath, input)
      const identity = new Set([paths.manifest, ...paths.lockfiles])
      return (path) => identity.has(path)
    }
    // A link's identity is its own target string, which changes only as a
    // change to the link's path; what it points at is never its input.
    case "Link": {
      const resolved = Input.resolvePath(packagePath, input.path)
      return (path) => resolved === path
    }
    // Ambient inputs affect their target but do not own changed paths.
    case "GitDiff":
    case "PnpmWorkspace":
      return () => false
  }
}

/** Selects roots, among the union of the patterns, whose declarations, package inputs or dependencies may have changed.
 * Every uncacheable target, and each target depending on one, is selected by any change.
 * @category querying
 * @since 0.1.0
 */
export const select = (
  index: PackageIndex,
  patterns: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
  options: { readonly explain?: boolean; readonly cacheDirectory?: string } = {}
) => {
  const normalized = [
    ...new Set(paths.map((path) => {
      const value = path.replaceAll("\\", "/").replace(/^\.\//, "")
      if (value === "" || Path.posix.isAbsolute(value) || value.split("/").includes("..")) {
        throw new Error(`invalid workspace-relative changed path: ${path}`)
      }
      return value
    }))
  ].sort()
  const rows = index.targets()
  const selected = [
    ...new Map(patterns.flatMap((pattern) => index.resolve(pattern)).map((row) => [row.label, row])).values()
  ]
  const reasons = new Map<string, Set<string>>()
  const reasonDetails = new Map<Target.AnyTarget, Array<ReasonDetail>>()
  const labels = new Map(rows.map((row) => [row.target, row.label]))
  let privateCounter = 0
  const labelOf = (target: Target.AnyTarget): string => {
    let label = labels.get(target)
    if (label === undefined) {
      // Diagnostic-local names, like the planner's private labels; never exported roots.
      const metadata = entry(target)
      label = `//${metadata.packagePath}:__private_${
        metadata.metadata.target.replace(/[^A-Za-z0-9]/g, "_")
      }_${++privateCounter}`
      labels.set(target, label)
    }
    return label
  }
  const globs = new Map<string, Minimatch>()
  const glob = (pattern: string): Minimatch => {
    let compiled = globs.get(pattern)
    if (compiled === undefined) {
      compiled = new Minimatch(pattern, { dot: true })
      globs.set(pattern, compiled)
    }
    return compiled
  }
  const cacheDirectory = options.cacheDirectory ?? index.workspace.cache.directory
  let realRoot = index.root
  let rootPresent = true
  try {
    realRoot = Fs.realpathSync(index.root)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    rootPresent = code !== "ENOENT" && code !== "ENOTDIR"
  }
  const links = new Map<string, ReadonlyArray<string> | undefined>()
  const indirectFiles = new Map<string, boolean>()
  const indirectFile = (path: string): boolean => {
    if (!rootPresent) return false
    const known = indirectFiles.get(path)
    if (known !== undefined) return known
    const absolute = Path.resolve(realRoot, path)
    let indirect = false
    try {
      const resolved = Fs.realpathSync(absolute)
      indirect = resolved !== absolute && contains(realRoot, resolved)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      // A dangling link may become readable when its referent is created.
      for (
        let current = absolute;
        current !== realRoot && current !== Path.dirname(current);
        current = Path.dirname(current)
      ) {
        try {
          if (Fs.lstatSync(current).isSymbolicLink()) {
            indirect = true
            break
          }
        } catch { /* An absent ancestor grants no additional authority. */ }
      }
      if (code !== "ENOENT" && code !== "ENOTDIR") indirect = true
    }
    indirectFiles.set(path, indirect)
    return indirect
  }
  const globLinks = (directory: string): ReadonlyArray<string> | undefined => {
    if (links.has(directory)) return links.get(directory)
    const found: Array<string> = []
    const pending = [directory]
    let entries = 0
    let listed = false
    try {
      for (const current of pending) {
        const children = Fs.readdirSync(Path.resolve(index.root, current), { withFileTypes: true })
        listed = true
        for (const item of children) {
          if (++entries > 100_000) {
            links.set(directory, undefined)
            return undefined
          }
          if (item.name === "node_modules" || item.name === ".git") continue
          const path = Path.posix.join(current, item.name)
          if (path === cacheDirectory || path.startsWith(cacheDirectory + "/")) continue
          if (item.isSymbolicLink()) found.push(path)
          // This is a conservative alias survey, not an input expansion.
          // Entered repositories can make nested packages readable.
          else if (item.isDirectory()) pending.push(path)
        }
      }
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (listed || code !== "ENOENT" && code !== "ENOTDIR") {
        links.set(directory, undefined)
        return undefined
      }
    }
    links.set(directory, found)
    return found
  }
  const indirectInput = (input: Input.Declared, packagePath: string): boolean => {
    if (!rootPresent) return false
    if (input._tag === "File") return indirectFile(Input.resolvePath(packagePath, input.path))
    if (input._tag === "NodeModules") {
      const paths = Input.nodeModulesPaths(packagePath, input)
      return [paths.tree, paths.manifest, ...paths.lockfiles].some(indirectFile)
    }
    if (input._tag !== "Glob") return false
    const pattern = glob(Input.resolvePath(packagePath, input.pattern))
    // Use the matcher's parsed alternatives, including literal patterns,
    // braces and extglobs. A fully literal pattern names a file, not a dir.
    return pattern.set.some((alternative) => {
      const segments: Array<string> = []
      for (const part of alternative) {
        if (typeof part !== "string") break
        segments.push(part)
      }
      if (segments.length === alternative.length) segments.pop()
      const found = globLinks(segments.join("/"))
      return found === undefined || found.some(compileInput(input, packagePath, glob))
    })
  }
  const entries = new Map<Target.AnyTarget, {
    readonly metadata: Target.Metadata
    readonly packagePath: string
    readonly ambient: boolean
    readonly ownsPath: (path: string) => boolean
    readonly declaredPath: (path: string) => boolean
  }>()
  const entry = (target: Target.AnyTarget) => {
    let value = entries.get(target)
    if (value !== undefined) return value
    const metadata = Target.metadata(target)
    const packagePath = index.ownerOf(target) ?? ""
    const packagePrefix = packagePath === "" ? undefined : `${packagePath}/`
    const inputs = metadata.inputs.map((input) => compileInput(input, inputPackage(metadata, packagePath), glob))
    value = {
      metadata,
      packagePath,
      ambient: metadata.inputs.some(ambientInput),
      declaredPath: (path) => inputs.some((input) => input(path)),
      // Membership catches new files, implicit compiler inputs and config lookups.
      // Each (target, path) pair is asked once: rows hold distinct targets and paths are deduplicated.
      ownsPath: (path) =>
        packagePrefix !== undefined && path.startsWith(packagePrefix) || inputs.some((input) => input(path))
    }
    entries.set(target, value)
    return value
  }
  const implementationRoots = productionSourceRoots().map((source) =>
    Path.relative(index.root, source.directory).replaceAll("\\", "/")
  )
    .filter((path) => path !== ".." && !path.startsWith("../") && !Path.isAbsolute(path))
  const workspaceInputs = managerFilesOf(index.workspace)
  const indirectWorkspace = workspaceInputs.some(indirectFile)
  // A declaration helper builds other packages' targets as a PACKAGE.ts does:
  // every module the declarations import, directly or by name, is a global input.
  // Named workspace imports also cover their source directory, including new files.
  const declarationModules = new Set(index.modules)
  const declarationRoots = index.moduleRoots
  const global = normalized.filter((path) =>
    globalPath(path) || workspaceInputs.includes(path) || indirectWorkspace || declarationModules.has(path) ||
    declarationRoots.some((directory) => directory === "." || path === directory || path.startsWith(`${directory}/`)) ||
    implementationRoots.some((directory) => path === directory || path.startsWith(`${directory}/`))
  )
  // An unowned file may be an ambient input; conservatively invalidate the graph.
  const ownership = normalized.length === 0 ? [] : rows.map((row) => entry(row.target))
  const unknown = normalized.filter((path) => !ownership.some((value) => value.ownsPath(path)))
  const conservative = global.length + unknown.length > 0
  if (conservative) {
    for (const row of selected) {
      reasons.set(row.label, new Set([...global, ...unknown]))
      if (options.explain) {
        reasonDetails.set(
          row.target,
          [...new Set([...global, ...unknown])].sort().map((file) => ({
            file,
            kind: global.includes(file) ? "global-input" : "unknown-input"
          }))
        )
      }
    }
  } else if (normalized.length > 0) {
    const direct = new Map<Target.AnyTarget, (path: string) => boolean>()
    const details = new Map<Target.AnyTarget, (file: string) => ReadonlyArray<ReasonDetail>>()
    const reverse = new Map<Target.AnyTarget, Set<Target.AnyTarget>>()
    const selectors = new Map<string, ReadonlyArray<Target.AnyTarget>>()
    const pending = selected.map((row) => row.target)
    // Index the selected closure once, including private and verb-specific edges.
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const target = pending[cursor]!
      if (direct.has(target)) continue
      const value = entry(target)
      const metadata = value.metadata
      const views = metadata.kinds.map((kind) => metadata.forKind(kind))
      const viewInputs = views.flatMap((view) => view.inputs)
      const readsPackage = RulePolicy.readsPackage(
        metadata.target,
        [metadata.attrs, ...views.map((view) => view.attrs)],
        index.workspace.sandboxes
      )
      const sandboxDirectories = RulePolicy.sandboxReadDirectories(
        metadata.target,
        [metadata.attrs, ...views.map((view) => view.attrs)],
        value.packagePath,
        cacheDirectory,
        [
          ...nodeModulesDirectories([".", value.packagePath]),
          ...[...metadata.inputs, ...viewInputs].flatMap((input) =>
            input._tag === "NodeModules"
              ? [Input.nodeModulesPaths(inputPackage(metadata, value.packagePath), input).tree]
              : []
          )
        ]
      )
      const sandboxInputs = sandboxDirectories.map((directory) => ({
        readPath: directory,
        matches: (path: string) =>
          directory === "." || directory === "" || path === directory || path.startsWith(directory + "/")
      }))
      const indirectDirectories = sandboxDirectories.filter(indirectFile)
      const indirect = [...metadata.inputs, ...viewInputs].filter((input) =>
        indirectInput(input, inputPackage(metadata, value.packagePath))
      )
      // An uncacheable target makes no promise that its inputs are complete: it may import
      // undeclared packages or read files it never declared. Only running it is sound.
      const uncacheable = RulePolicy.of(metadata.target).cache === undefined &&
        (!metadata.cacheable || views.some((view) => !view.cacheable))
      const everyChange = indirect.length > 0 || indirectDirectories.length > 0 || value.ambient ||
        viewInputs.some(ambientInput) || uncacheable
      const inputs = viewInputs
        .map((input) => compileInput(input, inputPackage(metadata, value.packagePath), glob))
      direct.set(
        target,
        (path) =>
          everyChange || value.declaredPath(path) || sandboxInputs.some((input) => input.matches(path)) ||
          readsPackage && value.packagePath !== "" && path.startsWith(`${value.packagePath}/`) ||
          inputs.some((input) => input(path)) ||
          metadata.inputs.length === 0 && metadata.dependencies.length === 0
      )
      if (options.explain) {
        const declarations = [...new Set([...metadata.inputs, ...viewInputs])]
        const declared = declarations.map((input) => ({
          input,
          matches: compileInput(input, inputPackage(metadata, value.packagePath), glob)
        }))
        details.set(target, (file) => {
          const source = { file, label: labelOf(target), rule: metadata.target }
          const causes: Array<ReasonDetail> = []
          for (const { input, matches } of declared) {
            if (ambientInput(input)) causes.push({ ...source, kind: "ambient-input", input })
            else if (matches(file)) causes.push({ ...source, kind: "declared-input", input })
          }
          for (const { readPath, matches } of sandboxInputs) {
            if (matches(file)) causes.push({ ...source, kind: "sandbox-input", readPath })
          }
          for (const input of indirect) causes.push({ ...source, kind: "indirect-input", input })
          for (const readPath of indirectDirectories) causes.push({ ...source, kind: "indirect-input", readPath })
          if (uncacheable) causes.push({ ...source, kind: "uncacheable" })
          if (readsPackage && value.packagePath !== "" && file.startsWith(`${value.packagePath}/`)) {
            causes.push({ ...source, kind: "package" })
          }
          if (metadata.inputs.length === 0 && metadata.dependencies.length === 0) {
            causes.push({ ...source, kind: "empty" })
          }
          return causes
        })
      }
      const dependencies = new Set([
        ...metadata.dependencies,
        ...views.flatMap((view) => view.dependencies)
      ])
      for (const selector of [...metadata.dependencySelectors, ...views.flatMap((view) => view.dependencySelectors)]) {
        const label = `${selector.pattern}:${selector.target}`
        let resolved = selectors.get(label)
        if (resolved === undefined) {
          resolved = index.resolve(label).map((row) => row.target)
          selectors.set(label, resolved)
        }
        for (const dependency of resolved) dependencies.add(dependency)
      }
      for (const dependency of dependencies) {
        let dependents = reverse.get(dependency)
        if (dependents === undefined) reverse.set(dependency, dependents = new Set())
        dependents.add(target)
        pending.push(dependency)
      }
    }
    const roots = new Set(selected.map((row) => row.target))
    for (const path of normalized) {
      const affected = new Set<Target.AnyTarget>()
      for (const [target, matches] of direct) if (matches(path)) affected.add(target)
      if (options.explain) {
        for (const source of affected) {
          const causes = details.get(source)!(path)
          // One shortest route per source, including shared/private/cyclic dependencies.
          const routes = new Map<Target.AnyTarget, ReadonlyArray<string>>([[source, [labelOf(source)]]])
          for (const [target, route] of routes) {
            if (roots.has(target)) {
              let into = reasonDetails.get(target)
              if (into === undefined) reasonDetails.set(target, into = [])
              into.push(...causes.map((cause) => ({ ...cause, dependencyPath: [...route].reverse() })))
            }
            for (const dependent of reverse.get(target) ?? []) {
              if (!routes.has(dependent)) routes.set(dependent, [...route, labelOf(dependent)])
            }
          }
        }
      }
      // Set iteration includes newly added dependents and visits each target/path once,
      // even when several selected roots share dependencies or the graph has a cycle.
      for (const target of affected) {
        for (const dependent of reverse.get(target) ?? []) affected.add(dependent)
      }
      for (const row of selected) {
        if (!affected.has(row.target)) continue
        let causes = reasons.get(row.label)
        if (causes === undefined) reasons.set(row.label, causes = new Set())
        causes.add(path)
      }
    }
  }
  return {
    pattern: patterns.join(" "),
    files: normalized,
    conservative,
    globalInputs: [...new Set([...global, ...unknown])].sort(),
    targets: selected.filter((row) => reasons.has(row.label)).map((row) => ({
      label: row.label,
      reasons: [...reasons.get(row.label)!].sort(),
      // Explaining records details for every target it gives a reason.
      ...(options.explain ? { reasonDetails: reasonDetails.get(row.target)! } : {})
    }))
  }
}

/**
 * Whether changed files meet a pattern that names no target: an empty graph
 * or a renamed package, which would otherwise gate a real diff with nothing
 * and pass green. Pass the number of targets each pattern resolves to. A
 * pattern that resolves but whose targets the diff does not reach, or that
 * have no rule of the verb's kind, is a legitimate green.
 *
 * @category selection
 * @since 1.0.0
 */
export const silent = (files: ReadonlyArray<string>, resolved: ReadonlyArray<number>): boolean =>
  files.length > 0 && resolved.some((count) => count === 0)

/**
 * The labels an execution summary holds no record of: a planned target the
 * executor never recorded never ran, and that is red.
 *
 * @category selection
 * @since 1.0.0
 */
export const unrecorded = (
  labels: ReadonlyArray<string>,
  summary: { readonly results: ReadonlyArray<{ readonly label: string }> }
): ReadonlyArray<string> => {
  const recorded = new Set(summary.results.map((row) => row.label))
  return labels.filter((label) => !recorded.has(label))
}

/**
 * A summary in which a selected gate was skipped without a failure behind it,
 * turned red. A skip is a failure's shadow only when its `blockedBy` chain ends
 * at a failed row; one that ends anywhere else never ran for a reason of its
 * own (a review whose engine is not installed here), whatever else failed. The
 * skipped rows become failed rows that keep their reason, so the results
 * survive and the known-red list can still excuse one by label and failure.
 *
 * @category selection
 * @since 1.0.0
 */
export const unskipped = <
  S extends {
    readonly ok: boolean
    readonly counts: { readonly failed: number; readonly skipped: number }
    readonly results: ReadonlyArray<
      {
        readonly label: string
        readonly status: string
        readonly error?: string | undefined
        readonly blockedBy?: string | undefined
      }
    >
  }
>(labels: ReadonlyArray<string>, summary: S): S => {
  const selected = new Set(labels)
  const byLabel = new Map(summary.results.map((row) => [row.label, row]))
  const shadowOfFailure = (row: S["results"][number]): boolean => {
    const seen = new Set<string>()
    let current: S["results"][number] | undefined = row
    while (current !== undefined && current.status === "skipped" && current.blockedBy !== undefined) {
      if (seen.has(current.label)) return false
      seen.add(current.label)
      current = byLabel.get(current.blockedBy)
    }
    return current?.status === "failed"
  }
  const skipped = summary.results.filter((row) =>
    selected.has(row.label) && row.status === "skipped" && !shadowOfFailure(row)
  )
  if (skipped.length === 0) return summary
  return {
    ...summary,
    ok: false,
    counts: {
      ...summary.counts,
      failed: summary.counts.failed + skipped.length,
      skipped: summary.counts.skipped - skipped.length
    },
    results: summary.results.map((row) =>
      skipped.includes(row)
        ? { ...row, status: "failed", error: `skipped without running: ${row.error ?? "no reason recorded"}` }
        : row
    )
  }
}
