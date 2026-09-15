/**
 * Ignore-blind PACKAGE.ts / WORKSPACE.ts discovery.
 *
 * Discovery walks the filesystem from the canonical workspace root and never
 * consults git: gitignore status is irrelevant, so a gitignored or generated
 * PACKAGE.ts participates like any other. The walk prunes `.git`,
 * `node_modules`, distribution output (`dist`), nested checkouts (any directory
 * carrying its own `.git`), and the resolved cache directory, admits declaration files
 * through the shared SafeFs policy, and rejects a symlinked declaration file
 * outright.
 *
 * @since 0.1.0
 */
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { factoryFileBeside } from "./FactoryLoader.ts"
import { byCodeUnit, posix } from "./internal/Text.ts"
import { PackageError } from "./PackageError.ts"

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
  /** `.smithers/WORKSPACE.ts`, or the root `WORKSPACE.ts` fallback. */
  readonly workspaceFile: string
  /** The `FACTORY.ts` beside the workspace file, when the workspace declares a factory. */
  readonly factoryFile?: string | undefined
  /** Every exact-case `PACKAGE.ts` in the tree. */
  readonly packageFiles: ReadonlyArray<string>
  /** The cache directory the walk pruned. */
  readonly cacheDirectory: string
  /** Declared opaque child repositories, sorted by name. */
  readonly repositories: ReadonlyArray<RepositoryBoundary>
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
    for (
      const candidate of [
        NodePath.join(directory, ".smithers", "WORKSPACE.ts"),
        NodePath.join(directory, "WORKSPACE.ts")
      ]
    ) {
      if (await declarationAt(candidate)) return directory
    }
    const parent = NodePath.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * The workspace declaration file a root holds: `.smithers/WORKSPACE.ts`
 * first, the root `WORKSPACE.ts` fallback, or undefined when neither
 * exists. A cheap lstat probe like {@link findWorkspaceRoot}; {@link discover}
 * re-admits the file under the full SafeFs policy.
 *
 * @category discovery
 * @since 0.1.0
 */
export const workspaceFileOf = async (root: string): Promise<string | undefined> => {
  for (const candidate of [".smithers/WORKSPACE.ts", "WORKSPACE.ts"]) {
    if (await declarationAt(NodePath.join(root, candidate))) return candidate
  }
  return undefined
}

interface Walk {
  readonly root: string
  readonly cacheDirectory: string
  /** This workspace's own descriptor, which never marks a nested workspace. */
  readonly workspaceFile: string
  readonly signal: AbortSignal | undefined
  readonly found: Array<string>
  readonly repositories: ReadonlySet<string>
  directories: number
  entries: number
}

const pruned = (walk: Walk, child: string): boolean =>
  child === walk.cacheDirectory ||
  child.startsWith(`${walk.cacheDirectory}/`) ||
  child === fixedStoreDirectory ||
  child.startsWith(`${fixedStoreDirectory}/`)

/**
 * Whether a child directory starts a nested package workspace.
 *
 * The workspace's own descriptor is excluded: a repository whose root
 * declaration is `.smithers/WORKSPACE.ts` would otherwise see its own
 * `.smithers/` directory as a nested workspace and prune it from the walk.
 */
const nestedWorkspace = async (walk: Walk, child: string): Promise<boolean> => {
  const probes = ["WORKSPACE.ts", ".smithers/WORKSPACE.ts"]
    .filter((relative) => `${child}/${relative}` !== walk.workspaceFile)
    .map((relative) => declarationAt(NodePath.join(walk.root, child, relative)))
  return (await Promise.all(probes)).some((found) => found)
}

/**
 * Whether a child directory is another checkout: a clone's `.git` directory
 * or the `.git` file a linked worktree carries. Git never lists such a tree
 * as part of this repository, and neither does discovery, so the stale
 * declarations an agent worktree or a vendored clone holds are never read.
 */
const nestedCheckout = (walk: Walk, child: string): Promise<boolean> =>
  Fs.lstat(NodePath.join(walk.root, child, ".git")).then(() => true, () => false)

const walkDirectory = async (walk: Walk, relative: string): Promise<void> => {
  walk.signal?.throwIfAborted()
  const depth = relative === "" ? 0 : relative.split("/").length
  if (depth > limits.depth) {
    throw new PackageError("inventory_limit_exceeded", `discovery exceeds its depth limit of ${limits.depth}`, {
      path: relative
    })
  }
  const absolute = NodePath.join(walk.root, relative)
  const entry = await SafeFs.resolveDirectory(absolute, { root: walk.root, what: "workspace directory" })
  if (entry === undefined) return
  walk.directories += 1
  if (walk.directories > limits.directories) {
    throw new PackageError("inventory_limit_exceeded", `discovery exceeds its directory limit of ${limits.directories}`)
  }
  const entries = await SafeFs.listDirectory(absolute, entry, { root: walk.root, what: "workspace directory" })
  walk.entries += entries.length
  if (walk.entries > limits.entries) {
    throw new PackageError("inventory_limit_exceeded", `discovery exceeds its entry limit of ${limits.entries}`)
  }
  // Classify this listing without I/O, then descend into every child
  // directory concurrently. The walk is latency-bound on per-directory stat
  // calls rather than CPU-bound, so a serial descent costs seconds on a
  // workspace with thousands of directories. Concurrency cannot change the
  // inventory: `walk.found` is sorted by the caller, so discovery order never
  // escapes this function.
  const directories: Array<string> = []
  if (entries.some((child) => child.name === "BUILD.ts")) {
    const path = relative === "" ? "BUILD.ts" : `${relative}/BUILD.ts`
    throw new PackageError(
      "duplicate_package_path",
      `unsupported declaration ${path}; delete it and declare targets in PACKAGE.ts`,
      { path }
    )
  }
  const nestedMarker = entries.find((child) =>
    child.name === "WORKSPACE.ts" && !child.isDirectory() &&
    (relative !== "" && (relative !== ".smithers" || NodePath.posix.dirname(relative) !== "."))
  )
  if (nestedMarker !== undefined) {
    const marker = relative === "" ? nestedMarker.name : `${relative}/${nestedMarker.name}`
    const repositoryPath = relative.endsWith("/.smithers")
      ? NodePath.posix.dirname(relative)
      : relative
    const suggested = (NodePath.posix.basename(repositoryPath) || "repo").replace(/[^A-Za-z0-9._-]/g, "-")
    throw new PackageError(
      "nested_workspace_undeclared",
      `nested workspace ${marker} is not declared; add repos: { ${suggested}: S.LocalRepository(${
        JSON.stringify(repositoryPath)
      }) } to the root Workspace declaration`,
      { path: marker }
    )
  }
  for (const child of entries) {
    walk.signal?.throwIfAborted()
    // Distribution trees are build products, never package declarations.
    // Prune before any probes: a concurrent release build can replace them
    // while unrelated targets are being planned.
    if (child.name === ".git" || child.name === "node_modules" || child.name === "dist") continue
    const childRelative = relative === "" ? child.name : `${relative}/${child.name}`
    if (walk.repositories.has(childRelative)) continue
    if (pruned(walk, childRelative)) continue
    if (child.name === "PACKAGE.ts" && !child.isDirectory()) {
      if (child.isSymbolicLink()) {
        throw new PackageError(
          "module_not_regular",
          "PACKAGE.ts is a symbolic link; declaration modules must be regular files",
          {
            path: childRelative
          }
        )
      }
      if (!child.isFile()) {
        throw new PackageError("module_not_regular", "PACKAGE.ts is not a regular file", { path: childRelative })
      }
      walk.found.push(childRelative)
      continue
    }
    if (child.isDirectory()) directories.push(childRelative)
  }
  await Promise.all(directories.map(async (childRelative) => {
    if (walk.repositories.has(childRelative)) return
    if (await nestedCheckout(walk, childRelative)) return
    if (await nestedWorkspace(walk, childRelative)) {
      const marker = `${childRelative}/WORKSPACE.ts`
      const nested = await workspaceFileOf(NodePath.join(walk.root, childRelative))
      throw new PackageError(
        "nested_workspace_undeclared",
        `nested workspace ${nested === undefined ? marker : `${childRelative}/${nested}`} is not declared; ` +
          `add repos: { ${NodePath.posix.basename(childRelative).replace(/[^A-Za-z0-9._-]/g, "-")}: ` +
          `S.LocalRepository(${JSON.stringify(childRelative)}) } to the root Workspace declaration`,
        { path: nested === undefined ? marker : `${childRelative}/${nested}` }
      )
    }
    await walkDirectory(walk, childRelative)
  }))
}

/** Admits one declaration file: regular, contained, and never a symlink. */
const admitDeclaration = async (root: string, relative: string): Promise<boolean> => {
  const entry = await SafeFs.resolveFile(NodePath.join(root, relative), {
    root,
    what: relative.endsWith("WORKSPACE.ts")
      ? "WORKSPACE.ts"
      : relative.endsWith("FACTORY.ts")
      ? "FACTORY.ts"
      : "PACKAGE.ts",
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
    readonly signal?: AbortSignal | undefined
  } = {}
): Promise<Discovery> => {
  const canonical = await SafeFs.canonicalRoot(root)
  const cacheDirectory = posix(options.cacheDirectory ?? ".flows")
  const repositories = Object.entries(options.repositories ?? {})
    .map(([name, repository]) => ({ name, path: repository.path }))
    .sort((left, right) => byCodeUnit(left.name, right.name))
  let workspaceFile: string | undefined
  for (const candidate of [".smithers/WORKSPACE.ts", "WORKSPACE.ts"]) {
    let present: boolean
    try {
      present = await admitDeclaration(canonical, candidate)
    } catch (cause) {
      throw new PackageError("module_not_regular", "the workspace declaration could not be admitted", {
        path: candidate,
        cause
      })
    }
    if (present) {
      workspaceFile = candidate
      break
    }
  }
  if (workspaceFile === undefined) {
    throw new PackageError(
      "workspace_root_invalid",
      "the workspace root has no .smithers/WORKSPACE.ts and no WORKSPACE.ts",
      { path: posix(NodePath.relative(process.cwd(), canonical)) || "." }
    )
  }
  // The factory is declared beside the workspace, never anywhere else: a
  // FACTORY.ts elsewhere in the tree is an ordinary module.
  const factoryCandidate = factoryFileBeside(workspaceFile)
  let factoryFile: string | undefined
  try {
    factoryFile = (await admitDeclaration(canonical, factoryCandidate)) ? factoryCandidate : undefined
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
  const walk: Walk = {
    root: canonical,
    cacheDirectory,
    workspaceFile,
    signal: options.signal,
    found: [],
    repositories: new Set(repositories.map((repository) => repository.path)),
    directories: 0,
    entries: 0
  }
  await walkDirectory(walk, "")
  const packageFiles = [...walk.found].sort(byCodeUnit)
  // A symlinked PACKAGE.ts inside the walk already failed; re-admission here
  // closes the directory-rename race between the listing and the import.
  for (const file of packageFiles) {
    const admitted = await admitDeclaration(canonical, file)
    if (!admitted) {
      throw new PackageError("module_missing", "PACKAGE.ts disappeared during discovery", { path: file })
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
  return { root: canonical, workspaceFile, factoryFile, packageFiles, cacheDirectory, repositories }
}
