/**
 * Ignore-blind package declaration (PACKAGE.ts, PACKAGE.vibe) and
 * workspace declaration (WORKSPACE.ts, WORKSPACE.smithers) discovery.
 *
 * Discovery walks the filesystem from the canonical workspace root and never
 * consults git: gitignore status is irrelevant, so a gitignored or generated
 * PACKAGE.ts participates like any other. The walk prunes `.git`,
 * `node_modules`, distribution output (`dist`), nested checkouts (any directory
 * whose listing holds `.git` or `.jj`), caches tagged with `CACHEDIR.TAG`, the
 * resolved cache directory, declared child repositories, and the workspace's
 * declared `discovery.prune` paths, admits declaration files
 * through the shared SafeFs policy, and rejects a symlinked declaration file
 * outright.
 *
 * @since 0.1.0
 */

import * as Input from "@smthrs/targets/Input"
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { factoryFileBeside } from "./FactoryLoader.ts"
import { byCodeUnit, posix } from "./internal/Text.ts"
import { workspaceFileNames, workspaceFiles } from "./internal/WorkspaceFiles.ts"
import { PackageError } from "./PackageError.ts"

export { isWorkspaceFileName, plainWorkspaceFile, workspaceFiles } from "./internal/WorkspaceFiles.ts"

/** Hard traversal ceilings; a workspace beyond them fails, never truncates. */
const limits = {
  directories: 100_000,
  depth: 256,
  entries: 1_000_000
}

const fixedStoreDirectory = ".flows/store"

/**
 * The discovered declaration inventory of one workspace.
 *
 * All paths are workspace-relative posix, sorted by UTF-16 code unit.
 *
 * @category models
 * @since 0.1.0
 */
export interface Discovery {
  /** The canonical workspace root. */
  readonly root: string
  /**
   * `.smithers/WORKSPACE.ts`, `.smithers/WORKSPACE.smithers`, or the root
   * `WORKSPACE.ts` fallback, workspace-relative. The file `--workspace-file`
   * names is recorded by its absolute canonical path instead: it may lie
   * outside the workspace, and it is a plain workspace file whatever its name.
   */
  readonly workspaceFile: string
  /**
   * The `FACTORY.ts` beside the workspace file, when the workspace declares a
   * factory. A workspace read from `--workspace-file` declares none.
   */
  readonly factoryFile?: string | undefined
  /** Every exact-case package declaration (`PACKAGE.ts` or `PACKAGE.vibe`) in the tree. */
  readonly packageFiles: ReadonlyArray<string>
  /** The cache directory the walk pruned. */
  readonly cacheDirectory: string
  /** Declared opaque child repositories, sorted by name. */
  readonly repositories: ReadonlyArray<RepositoryBoundary>
  /**
   * Directories the walk skipped whole: declared `discovery.prune` paths
   * that exist, nested checkouts, and `CACHEDIR.TAG` caches.
   */
  readonly pruned: ReadonlyArray<string>
  /** How many directories the walk listed. */
  readonly directories: number
}

/**
 * One named opaque child-repository boundary.
 *
 * @category models
 * @since 0.1.0
 */
export interface RepositoryBoundary {
  readonly name: string
  readonly path: string
}

/** Reports whether a declaration exists with exactly the requested spelling. */
const declarationAt = async (absolute: string): Promise<boolean> => {
  try {
    const stats = await Fs.lstat(absolute)
    if (!(stats.isFile() || stats.isSymbolicLink())) return false
    const entries = await Fs.readdir(NodePath.dirname(absolute))
    return entries.includes(NodePath.basename(absolute))
  } catch {
    return false
  }
}

/**
 * The nearest ancestor of `start` that holds a workspace declaration, or
 * undefined when no ancestor does.
 *
 * The presence probe is deliberately cheap; {@link discover} re-admits the
 * file under the full SafeFs policy.
 *
 * @category discovery
 * @since 0.1.0
 */
export const findWorkspaceRoot = async (start: string): Promise<string | undefined> => {
  let directory = NodePath.resolve(start)
  while (true) {
    for (const candidate of workspaceFiles) {
      if (await declarationAt(NodePath.join(directory, ...candidate.split("/")))) return directory
    }
    const parent = NodePath.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * The workspace declaration file a root holds: `.smithers/WORKSPACE.ts`
 * first, then `.smithers/WORKSPACE.smithers`, then the root `WORKSPACE.ts`
 * fallback, or undefined when none exists. A cheap lstat probe like {@link findWorkspaceRoot}; {@link discover}
 * re-admits the file under the full SafeFs policy.
 *
 * @category discovery
 * @since 0.1.0
 */
export const workspaceFileOf = async (root: string): Promise<string | undefined> => {
  for (const candidate of workspaceFiles) {
    if (await declarationAt(NodePath.join(root, ...candidate.split("/")))) return candidate
  }
  return undefined
}

/**
 * Admits the file `--workspace-file` names and returns its absolute canonical
 * path. The path may be absolute or relative to the process working
 * directory, and may lie outside the workspace. It must resolve to a regular
 * file: a missing path, a directory, a FIFO or a device fails with a
 * `PackageError` naming the path, before anything opens it. A symbolic link is
 * followed, so the file's own imports resolve from where it really is.
 *
 * @category discovery
 * @since 1.0.0
 */
export const workspaceFileAt = async (path: string): Promise<string> => {
  const absolute = NodePath.resolve(path)
  let canonical: string
  try {
    canonical = await Fs.realpath(absolute)
  } catch (cause) {
    throw new PackageError("module_missing", "the workspace file does not exist", { path: absolute, cause })
  }
  const stats = await Fs.stat(canonical)
  if (!stats.isFile()) {
    throw new PackageError("module_not_regular", "the workspace file is not a regular file", { path: absolute })
  }
  return canonical
}

interface Walk {
  readonly root: string
  readonly io: SafeFs.Io | undefined
  readonly signal: AbortSignal | undefined
  readonly found: Array<string>
  /**
   * Workspace-relative paths the walk never enters: the cache directory, the
   * fixed store, declared child repositories, and declared `discovery.prune`
   * paths.
   */
  readonly boundaries: ReadonlySet<string>
  /** The declared `discovery.prune` paths, recorded in {@link Discovery.pruned} when present. */
  readonly declaredPrune: ReadonlySet<string>
  /** Directories the walk skipped by a declared prune path or by a marker in their own listing. */
  readonly pruned: Array<string>
  directories: number
  entries: number
}

/**
 * Directory names skipped at any depth before any I/O on them. The root
 * checkout's own version-control stores (`.git`, `.jj`) are never workspace
 * content, and jj's operation index grows without bound.
 */
const skippedNames: ReadonlySet<string> = new Set([".git", ".jj", "node_modules", "dist"])

/**
 * Entries whose presence in a directory's own listing marks the whole
 * directory as something no declaration can live in: another checkout (a
 * clone's `.git` directory, the `.git` file a linked worktree carries, or a jj
 * workspace's `.jj`), or a cache that follows the Cache Directory Tagging
 * convention (`CACHEDIR.TAG`, which Cargo writes into `target/`).
 */
const prunedMarkers: ReadonlySet<string> = new Set([".git", ".jj", "CACHEDIR.TAG"])

const undeclaredNestedWorkspace = (repositoryPath: string, marker: string): PackageError =>
  new PackageError(
    "nested_workspace_undeclared",
    `nested workspace ${marker} is not declared; add repos: { ${
      NodePath.posix.basename(repositoryPath).replace(/[^A-Za-z0-9._-]/g, "-")
    }: S.LocalRepository(${JSON.stringify(repositoryPath)}) } to the root Workspace declaration`,
    { path: marker }
  )

/**
 * Refuses a directory that declares its package twice, once in TypeScript and
 * once in VibeLang: neither file silently wins.
 */
const twoDeclarations = (relative: string, names: ReadonlyArray<string>): PackageError => {
  const files = names.map((name) => relative === "" ? name : `${relative}/${name}`).sort(byCodeUnit)
  return new PackageError(
    "duplicate_package_path",
    `${files.join(" and ")} both declare //${relative}; keep one of them`,
    { path: files[0] }
  )
}

/**
 * Walks one directory. Each directory costs one confined resolve and one
 * confined listing and nothing else: every classification of a child, the
 * nested-checkout and nested-workspace checks included, is answered from a
 * listing the walk already holds.
 */
const walkDirectory = async (walk: Walk, relative: string): Promise<void> => {
  walk.signal?.throwIfAborted()
  const depth = relative === "" ? 0 : relative.split("/").length
  if (depth > limits.depth) {
    throw new PackageError("inventory_limit_exceeded", `discovery exceeds its depth limit of ${limits.depth}`, {
      path: relative
    })
  }
  const absolute = NodePath.join(walk.root, relative)
  const entry = await SafeFs.resolveDirectory(absolute, { root: walk.root, io: walk.io, what: "workspace directory" })
  if (entry === undefined) return
  walk.directories += 1
  if (walk.directories > limits.directories) {
    throw new PackageError("inventory_limit_exceeded", `discovery exceeds its directory limit of ${limits.directories}`)
  }
  const entries = await SafeFs.listDirectory(absolute, entry, {
    root: walk.root,
    io: walk.io,
    what: "workspace directory"
  })
  walk.entries += entries.length
  if (walk.entries > limits.entries) {
    throw new PackageError("inventory_limit_exceeded", `discovery exceeds its entry limit of ${limits.entries}`)
  }
  if (relative !== "") {
    // Another checkout or a tagged cache: nothing below it is this
    // workspace's declaration, including a WORKSPACE.ts or an old BUILD.ts.
    if (entries.some((child) => prunedMarkers.has(child.name))) {
      walk.pruned.push(relative)
      return
    }
    // A nested workspace this root did not declare. The root's own
    // `.smithers/` holds this workspace's descriptor and is never one.
    if (relative !== ".smithers") {
      if (entries.some((child) => child.name === ".smithers" && child.isDirectory())) {
        for (const name of workspaceFileNames) {
          if (await declarationAt(NodePath.join(absolute, ".smithers", name))) {
            throw undeclaredNestedWorkspace(relative, `${relative}/.smithers/${name}`)
          }
        }
      }
      if (entries.some((child) => child.name === "WORKSPACE.ts" && !child.isDirectory())) {
        throw undeclaredNestedWorkspace(relative, `${relative}/WORKSPACE.ts`)
      }
    }
  }
  if (entries.some((child) => child.name === "BUILD.ts")) {
    const path = relative === "" ? "BUILD.ts" : `${relative}/BUILD.ts`
    throw new PackageError(
      "duplicate_package_path",
      `unsupported declaration ${path}; delete it and declare targets in PACKAGE.ts`,
      { path }
    )
  }
  // Classify this listing without I/O, then descend into every child
  // directory concurrently. The walk is latency-bound on per-directory stat
  // calls rather than CPU-bound, so a serial descent costs seconds on a
  // workspace with thousands of directories. Concurrency cannot change the
  // inventory: `walk.found` is sorted by the caller, so discovery order never
  // escapes this function.
  const directories: Array<string> = []
  const declarations: Array<string> = []
  for (const child of entries) {
    walk.signal?.throwIfAborted()
    // Distribution trees are build products, never package declarations.
    // Prune before any probes: a concurrent release build can replace them
    // while unrelated targets are being planned.
    if (skippedNames.has(child.name)) continue
    const childRelative = relative === "" ? child.name : `${relative}/${child.name}`
    if (walk.boundaries.has(childRelative)) {
      if (walk.declaredPrune.has(childRelative)) walk.pruned.push(childRelative)
      continue
    }
    if (Input.isDeclarationFileName(child.name) && !child.isDirectory()) {
      if (child.isSymbolicLink()) {
        throw new PackageError(
          "module_not_regular",
          `${child.name} is a symbolic link; declaration modules must be regular files`,
          {
            path: childRelative
          }
        )
      }
      if (!child.isFile()) {
        throw new PackageError("module_not_regular", `${child.name} is not a regular file`, { path: childRelative })
      }
      declarations.push(child.name)
      walk.found.push(childRelative)
      continue
    }
    if (child.isDirectory()) directories.push(childRelative)
  }
  if (declarations.length > 1) throw twoDeclarations(relative, declarations)
  await Promise.all(directories.map((childRelative) => walkDirectory(walk, childRelative)))
}

/**
 * The boundaries a workspace declaration draws around its own discovery.
 *
 * @category models
 * @since 1.0.0
 */
export interface Boundaries {
  readonly cacheDirectory?: string | undefined
  readonly repositories?: Readonly<Record<string, { readonly path: string }>> | undefined
  /** Workspace-relative posix directories the walk never enters (`discovery.prune`). */
  readonly prune?: ReadonlyArray<string> | undefined
}

/**
 * The declaration inventory a base revision held, read from the list of
 * files that revision holds and the boundaries its own workspace declared.
 *
 * Nothing here reads the checkout's tree, so a marker file, a nested
 * checkout or a `discovery.prune` path added since cannot hide a package the
 * base declared. The same rules as {@link discover} decide what the base
 * itself left out: its cache directory, child repositories and prune paths,
 * `node_modules` and `dist`, and a directory the base tagged with
 * `CACHEDIR.TAG` or held another checkout in. The workspace declaration must
 * be where the checkout has it; `--workspace-file` names the checkout's own
 * file and is kept.
 *
 * @category discovery
 * @since 1.0.0
 */
export const discoverAt = (checkout: Discovery, files: ReadonlyArray<string>, options: Boundaries = {}): Discovery => {
  const held = new Set(files)
  const given = NodePath.isAbsolute(checkout.workspaceFile)
  if (!given && workspaceFiles.find((candidate) => held.has(candidate)) !== checkout.workspaceFile) {
    throw new PackageError(
      "module_import_failed",
      `the base revision holds no workspace declaration at ${checkout.workspaceFile}`,
      { path: checkout.workspaceFile }
    )
  }
  const cacheDirectory = posix(options.cacheDirectory ?? ".flows")
  const repositories = Object.entries(options.repositories ?? {})
    .map(([name, repository]) => ({ name, path: repository.path }))
    .sort((left, right) => byCodeUnit(left.name, right.name))
  const declaredPrune = new Set(options.prune ?? [])
  const boundaries = new Set([
    cacheDirectory,
    fixedStoreDirectory,
    ...repositories.map((repository) => repository.path),
    ...declaredPrune
  ])
  /** Every path prefix of a file, shortest first: its ancestor directories, then itself. */
  const prefixes = (file: string): ReadonlyArray<string> => {
    const segments = file.split("/")
    return segments.map((_, index) => segments.slice(0, index + 1).join("/"))
  }
  // A marker anywhere below the root makes the directory holding it one the base never entered.
  const marked = new Set<string>()
  for (const file of files) {
    const segments = file.split("/")
    segments.forEach((segment, index) => {
      if (index > 0 && prunedMarkers.has(segment)) marked.add(segments.slice(0, index).join("/"))
    })
  }
  const pruned = new Set<string>(marked)
  const packageFiles: Array<string> = []
  for (const file of files) {
    const paths = prefixes(file)
    for (const path of paths) if (declaredPrune.has(path)) pruned.add(path)
    if (!Input.isDeclarationFileName(NodePath.posix.basename(file))) continue
    if (file.split("/").some((segment) => skippedNames.has(segment))) continue
    if (paths.some((path) => boundaries.has(path) || marked.has(path))) continue
    packageFiles.push(file)
  }
  packageFiles.sort(byCodeUnit)
  packageFiles.forEach((file, index) => {
    const next = packageFiles[index + 1]
    if (next !== undefined && NodePath.posix.dirname(next) === NodePath.posix.dirname(file)) {
      const directory = NodePath.posix.dirname(file)
      throw twoDeclarations(
        directory === "." ? "" : directory,
        [file, next].map((path) => NodePath.posix.basename(path))
      )
    }
  })
  const factoryCandidate = given ? undefined : factoryFileBeside(checkout.workspaceFile)
  return {
    root: checkout.root,
    workspaceFile: checkout.workspaceFile,
    factoryFile: factoryCandidate !== undefined && held.has(factoryCandidate) ? factoryCandidate : undefined,
    packageFiles,
    cacheDirectory,
    repositories,
    pruned: [...pruned].sort(byCodeUnit),
    directories: 0
  }
}

/** Admits one declaration file: regular, contained, and never a symlink. */
const admitDeclaration = async (root: string, relative: string): Promise<boolean> => {
  const entry = await SafeFs.resolveFile(NodePath.join(root, relative), {
    root,
    what: NodePath.posix.basename(relative),
    symlinks: "reject"
  })
  return entry !== undefined
}

/**
 * Discovers the workspace's declaration files without evaluating any of
 * them.
 *
 * @category discovery
 * @since 0.1.0
 */
export const discover = async (
  root: string,
  options: {
    readonly cacheDirectory?: string | undefined
    readonly repositories?: Readonly<Record<string, { readonly path: string }>> | undefined
    /** Workspace-relative posix directories the walk never enters (`discovery.prune`). */
    readonly prune?: ReadonlyArray<string> | undefined
    readonly signal?: AbortSignal | undefined
    /** The filesystem seam the walk lists through; tests count its calls. */
    readonly io?: SafeFs.Io | undefined
    /**
     * The file `--workspace-file` names. The workspace's own declaration
     * files are then neither looked for nor read, and no factory is declared.
     */
    readonly workspaceFile?: string | undefined
  } = {}
): Promise<Discovery> => {
  const canonical = await SafeFs.canonicalRoot(root)
  const cacheDirectory = posix(options.cacheDirectory ?? ".flows")
  const repositories = Object.entries(options.repositories ?? {})
    .map(([name, repository]) => ({ name, path: repository.path }))
    .sort((left, right) => byCodeUnit(left.name, right.name))
  const given = options.workspaceFile === undefined ? undefined : await workspaceFileAt(options.workspaceFile)
  const present: Array<string> = given === undefined ? [] : [given]
  for (const candidate of given === undefined ? workspaceFiles : []) {
    try {
      if (await admitDeclaration(canonical, candidate)) present.push(candidate)
    } catch (cause) {
      throw new PackageError("module_not_regular", "the workspace declaration could not be admitted", {
        path: candidate,
        cause
      })
    }
  }
  // One directory holds one declaration, as it does for PACKAGE.ts and
  // PACKAGE.vibe: neither file under `.smithers/` silently wins.
  const beside = present.filter((file) => file.startsWith(".smithers/"))
  if (beside.length > 1) {
    throw new PackageError(
      "workspace_root_invalid",
      `${beside.join(" and ")} both declare the workspace; keep one of them`,
      { path: beside[0] }
    )
  }
  const workspaceFile = present[0]
  if (workspaceFile === undefined) {
    throw new PackageError(
      "workspace_root_invalid",
      "the workspace root has no .smithers/WORKSPACE.ts, no .smithers/WORKSPACE.smithers and no WORKSPACE.ts",
      { path: posix(NodePath.relative(process.cwd(), canonical)) || "." }
    )
  }
  // The factory is declared beside the workspace, never anywhere else: a
  // FACTORY.ts elsewhere in the tree is an ordinary module.
  const factoryCandidate = factoryFileBeside(workspaceFile)
  let factoryFile: string | undefined
  try {
    factoryFile = given === undefined && (await admitDeclaration(canonical, factoryCandidate))
      ? factoryCandidate
      : undefined
  } catch (cause) {
    throw new PackageError("module_not_regular", "the factory declaration could not be admitted", {
      path: factoryCandidate,
      cause
    })
  }
  for (const repository of repositories) {
    const absolute = NodePath.join(canonical, ...repository.path.split("/"))
    let directory = false
    try {
      directory = (await Fs.stat(absolute)).isDirectory()
    } catch {
      // Report the stable repository diagnostic below.
    }
    if (!directory) {
      throw new PackageError(
        "local_repository_invalid",
        `workspace repo ${JSON.stringify(repository.name)} path is not a directory: ${repository.path}`,
        { path: repository.path }
      )
    }
    const marker = await workspaceFileOf(absolute)
    if (marker === undefined) {
      throw new PackageError(
        "local_repository_invalid",
        `workspace repo ${JSON.stringify(repository.name)} at ${repository.path} has no .smithers/WORKSPACE.ts ` +
          "and no WORKSPACE.ts",
        { path: repository.path }
      )
    }
  }
  const declaredPrune = new Set(options.prune ?? [])
  const walk: Walk = {
    root: canonical,
    io: options.io,
    signal: options.signal,
    found: [],
    boundaries: new Set([
      cacheDirectory,
      fixedStoreDirectory,
      ...repositories.map((repository) => repository.path),
      ...declaredPrune
    ]),
    declaredPrune,
    pruned: [],
    directories: 0,
    entries: 0
  }
  await walkDirectory(walk, "")
  const packageFiles = [...walk.found].sort(byCodeUnit)
  // A symlinked declaration inside the walk already failed; re-admission here
  // closes the directory-rename race between the listing and the import.
  for (const file of packageFiles) {
    const admitted = await admitDeclaration(canonical, file)
    if (!admitted) {
      throw new PackageError("module_missing", `${NodePath.posix.basename(file)} disappeared during discovery`, {
        path: file
      })
    }
  }
  const folded = new Map<string, string>()
  for (const file of packageFiles) {
    const key = file.toLowerCase()
    const existing = folded.get(key)
    if (existing !== undefined) {
      throw new PackageError(
        "case_collision",
        `two declaration paths collide case-insensitively: ${existing} and ${file}`,
        {
          path: file
        }
      )
    }
    folded.set(key, file)
  }
  return {
    root: canonical,
    workspaceFile,
    factoryFile,
    packageFiles,
    cacheDirectory,
    repositories,
    pruned: [...walk.pruned].sort(byCodeUnit),
    directories: walk.directories
  }
}
