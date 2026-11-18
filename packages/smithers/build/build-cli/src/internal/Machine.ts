/**
 * A machine: a private copy of the workspace with a home directory and a
 * temporary directory of its own, for the targets that name it.
 *
 * A CI system starts every job on a machine of its own: a fresh checkout, an
 * empty home, an empty temporary directory, and nothing another job did. The
 * targets that declare `machine: "<name>"` get the same in one build: they
 * share one copy, in the order they run, and no other target sees what they
 * write. The copy is made when the first of them has to run, so a build that
 * answers them all from the cache makes none.
 *
 * @since 1.0.0
 */

import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as PackageTree from "../PackageTree.ts"
import * as ObservedReads from "./ObservedReads.ts"

/**
 * One machine of a build: `tree` is its copy of the workspace, under the
 * workspace's own directory name, and `home` and `tmp` are its home and
 * temporary directories. All three are under `directory`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Machine {
  readonly name: string
  readonly directory: string
  readonly tree: string
  readonly home: string
  readonly tmp: string
}

/**
 * What a fresh checkout of a workspace holds, from the workspace root: every
 * file and link, and every directory on the way to one.
 *
 * @category models
 * @since 1.0.0
 */
export interface Fresh {
  readonly files: ReadonlySet<string>
  readonly directories: ReadonlySet<string>
}

/**
 * Runs git in a directory and answers what it printed.
 *
 * @category models
 * @since 1.0.0
 */
export type Git = (root: string, args: ReadonlyArray<string>) => Promise<string>

/**
 * The variable that names the directory machines are kept in. Without it
 * they are under the user's cache directory.
 *
 * @category constants
 * @since 1.0.0
 */
export const holdingVariable = "SMTHRS_MACHINES"

/**
 * The variable that names a directory whose contents every machine's home
 * starts with, as a CI image gives every runner the same home.
 *
 * @category constants
 * @since 1.0.0
 */
export const homeVariable = "SMTHRS_MACHINE_HOME"

/**
 * Where the machines of the workspace at `root` are kept: one directory for
 * the workspace, named by its path, outside the workspace. A tool that walks
 * up from a machine's copy so never finds a file of the workspace itself.
 * The directory is the same in every build of the workspace, because a
 * record of what a run read names the paths of its home.
 *
 * @category resolution
 * @since 1.0.0
 */
export const holding = (root: string, environment: Readonly<Record<string, string | undefined>>): string => {
  const base = environment[holdingVariable] ??
    NodePath.join(
      environment["XDG_CACHE_HOME"] ?? NodePath.join(environment["HOME"] as string, ".cache"),
      "smthrs",
      "machines"
    )
  return NodePath.join(base, createHash("sha256").update(root).digest("hex").slice(0, 16))
}

/**
 * Makes the directory the machines of the workspace at `root` are kept in,
 * empty: what an earlier build left there is removed. Answers its real path.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const prepare = async (
  root: string,
  environment: Readonly<Record<string, string | undefined>>
): Promise<string> => {
  const kept = holding(root, environment)
  await remove(kept)
  await Fs.mkdir(kept, { recursive: true })
  return Fs.realpath(kept)
}

/**
 * The machine named `name` among those kept in `kept`, for the workspace at
 * `root`. Nothing is made.
 *
 * @category resolution
 * @since 1.0.0
 */
export const named = (kept: string, root: string, name: string): Machine => {
  const readable = name.replaceAll(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40)
  const directory = NodePath.join(kept, `${readable}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`)
  return {
    name,
    directory,
    tree: NodePath.join(directory, "w", NodePath.basename(root)),
    home: NodePath.join(directory, "home"),
    tmp: NodePath.join(directory, "tmp")
  }
}

const under = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`)

/**
 * What a fresh checkout of the workspace at `root` holds, or `undefined`
 * when the workspace is not the root of a git checkout.
 *
 * It is what git tracks, as the working tree has it now, and every other
 * file `.gitignore` does not leave out: what a commit made now would hold.
 * An installed `node_modules` or a build's output is in no fresh checkout.
 * The cache directory is the build's own and never part of it.
 *
 * @category resolution
 * @since 1.0.0
 */
export const fresh = async (
  root: string,
  cacheDirectory: string,
  git: Git = PackageTree.runGit
): Promise<Fresh | undefined> => {
  if (!NodeFs.existsSync(NodePath.join(root, ".git"))) return undefined
  const listed = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-per-directory=.gitignore"])
  const files = new Set<string>()
  const directories = new Set<string>()
  for (const name of listed.split("\0")) {
    if (name === "" || under(name, cacheDirectory)) continue
    // A tracked file the working tree no longer holds is in no copy of it.
    const stats = NodeFs.lstatSync(NodePath.join(root, name), { throwIfNoEntry: false })
    if (stats === undefined) continue
    // A submodule is a directory git names as one entry: a fresh checkout holds it empty.
    if (stats.isDirectory()) directories.add(name)
    else files.add(name)
    for (let parent = NodePath.posix.dirname(name); parent !== "."; parent = NodePath.posix.dirname(parent)) {
      if (directories.has(parent)) break
      directories.add(parent)
    }
  }
  return { files, directories }
}

/**
 * A link in a machine's home: its path from the home, and where it leads.
 *
 * @category models
 * @since 1.0.0
 */
export interface Link {
  readonly path: string
  readonly target: string
}

/**
 * What a machine is made from, beside its name: the workspace, what a fresh
 * checkout of it holds, the directory machines are kept in, and what its home
 * starts with.
 *
 * @category models
 * @since 1.0.0
 */
export interface Start {
  readonly root: string
  readonly cacheDirectory: string
  readonly held: Fresh | undefined
  readonly kept: string
  readonly homeTemplate?: string | undefined
  readonly links?: ReadonlyArray<Link> | undefined
}

/**
 * The links of a machine's home among the links a confined run is given for
 * its private directories: those under `home/`, from the home.
 *
 * @category resolution
 * @since 1.0.0
 */
export const homeLinks = (links: ReadonlyArray<Link>): ReadonlyArray<Link> =>
  links.flatMap((link) =>
    link.path.startsWith("home/") ? [{ path: link.path.slice("home/".length), target: link.target }] : []
  )

/** What is at a path of a machine that is not made: a path of the host, a directory with its names, a link, or nothing. */
type Found =
  | { readonly at: string }
  | { readonly names: ReadonlyArray<string> }
  | { readonly link: string }
  | undefined

/**
 * The host as a machine that is not made yet would find it: the measurement
 * and the reads `ObservedReads.changed` asks with.
 *
 * A machine is made only for a target that runs, so a record is first held
 * against what the machine would start with. A path of the workspace that a
 * fresh checkout does not hold is missing; the cache directory and the
 * repository's own store are there, as they are in every copy. Under the
 * directory machines are kept in, every machine has its three directories:
 * the tree, an empty temporary directory, and a home that holds the template
 * and the links and nothing else. Any other path is the host's.
 *
 * @category resolution
 * @since 1.0.0
 */
export const unmade = (
  start: Start,
  measured: (path: string) => string = ObservedReads.measure,
  io: ObservedReads.Io = ObservedReads.defaultIo
): { readonly measured: (path: string) => string; readonly io: ObservedReads.Io } => {
  const { cacheDirectory, held, kept, root } = start
  const links = start.links ?? []
  const inWorkspace = (name: string): boolean =>
    held === undefined || name === "" || held.files.has(name) || held.directories.has(name) ||
    under(name, cacheDirectory) || under(name, ".git")
  const there = (path: string): boolean => {
    try {
      io.lstat(path)
      return true
    } catch {
      return false
    }
  }
  const namesIn = (path: string): ReadonlyArray<string> => {
    try {
      return io.readdir(path)
    } catch {
      return []
    }
  }
  const template = start.homeTemplate
  // A link never replaces what the template holds.
  const placed = links.filter((link) => template === undefined || !there(NodePath.join(template, link.path)))
  /** A path of a machine's home, from the home. */
  const inHome = (name: string): Found => {
    const link = placed.find((each) => under(name, each.path))
    if (link !== undefined) {
      return name === link.path ? { link: link.target } : { at: link.target + name.slice(link.path.length) }
    }
    const copied = template === undefined ? undefined : name === "" ? template : NodePath.join(template, name)
    // The directories on the way to a link are made with it.
    const heads = placed.flatMap((each) =>
      name === "" ? [each.path.split("/")[0]!] : each.path.startsWith(`${name}/`)
        ? [each.path.slice(name.length + 1).split("/")[0]!]
        : []
    )
    if (name === "" || heads.length > 0) {
      return { names: [...new Set([...(copied === undefined ? [] : namesIn(copied)), ...heads])] }
    }
    return copied === undefined ? undefined : { at: copied }
  }
  const find = (path: string): Found => {
    if (under(path, root)) return inWorkspace(path.slice(root.length + 1)) ? { at: path } : undefined
    if (!under(path, kept) || path === kept) return { at: path }
    const [, part, ...rest] = path.slice(kept.length + 1).split("/")
    if (part === undefined) return { names: ["home", "tmp", "w"] }
    if (part === "home") return inHome(rest.join("/"))
    if (part === "tmp") return rest.length === 0 ? { names: [] } : undefined
    if (part !== "w" || rest.length > 1 || (rest.length === 1 && rest[0] !== NodePath.basename(root))) return undefined
    return rest.length === 0 ? { names: [NodePath.basename(root)] } : { at: root }
  }
  const missing = (path: string): Error =>
    Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" })
  return {
    measured: (path) => {
      const found = find(path)
      if (found === undefined) return "-"
      if ("names" in found) return "d"
      return "link" in found ? `l:${found.link}` : measured(found.at)
    },
    io: {
      ...io,
      lstat: (path) => {
        const found = find(path)
        if (found === undefined) throw missing(path)
        // A directory or a link of a machine that is not made is there, and that is all a caller asks.
        return io.lstat("at" in found ? found.at : kept)
      },
      readdir: (path) => {
        const found = find(path)
        if (found === undefined) throw missing(path)
        if ("names" in found) return found.names
        if ("link" in found) return io.readdir(found.link)
        return io.readdir(found.at).filter((name) => find(`${path}/${name}`) !== undefined)
      }
    }
  }
}

/** Makes every directory under `path` one its owner can list and write, so that it can be removed. */
const unlock = async (path: string): Promise<void> => {
  const stats = await Fs.lstat(path).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) return
  await Fs.chmod(path, stats.mode | 0o700)
  for (const name of await Fs.readdir(path)) await unlock(NodePath.join(path, name))
}

/**
 * Removes a machine, or every machine kept in a directory. A tool can leave
 * a directory nothing can be removed from, as Go leaves its module cache, so
 * directories are made writable first.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const remove = async (directory: string): Promise<void> => {
  try {
    await Fs.rm(directory, { recursive: true, force: true })
  } catch {
    await unlock(directory)
    await Fs.rm(directory, { recursive: true, force: true })
  }
}

/** How many files are copied at once. */
const copies = 64

const inBatches = async <A>(items: ReadonlyArray<A>, each: (item: A) => Promise<void>): Promise<void> => {
  for (let start = 0; start < items.length; start += copies) {
    await Promise.all(items.slice(start, start + copies).map(each))
  }
}

/** Copies one file or link. A file system that can share a file's blocks does, so the copy costs no space. */
const copy = async (from: string, to: string): Promise<void> => {
  const stats = await Fs.lstat(from)
  if (stats.isSymbolicLink()) await Fs.symlink(await Fs.readlink(from), to)
  else await Fs.copyFile(from, to, NodeFs.constants.COPYFILE_FICLONE)
}

const copyIfThere = async (from: string, to: string): Promise<void> => {
  if (!NodeFs.existsSync(from)) return
  await Fs.mkdir(NodePath.dirname(to), { recursive: true })
  await Fs.cp(from, to, { recursive: true, verbatimSymlinks: true })
}

/**
 * Gives the copy at `tree` a repository of its own for the checkout at
 * `root`: the same commit checked out, the same branches, tags and remotes,
 * the same index, and the same objects, which it reads from the workspace's
 * store and never writes there. What a target does with git in the copy
 * (a commit, a tag, a changed configuration, a hook) stays in the copy.
 */
const repository = async (root: string, tree: string, git: Git): Promise<void> => {
  const own = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim()
  const common = NodePath.resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).trim())
  const store = NodePath.join(tree, ".git")
  for (const directory of ["objects/info", "objects/pack", "refs/heads", "refs/tags", "info"]) {
    await Fs.mkdir(NodePath.join(store, directory), { recursive: true })
  }
  await Fs.writeFile(NodePath.join(store, "objects", "info", "alternates"), `${NodePath.join(common, "objects")}\n`)
  for (const name of ["config", "packed-refs", "shallow", "refs", "info"]) {
    await copyIfThere(NodePath.join(common, name), NodePath.join(store, name))
  }
  for (const name of await Fs.readdir(own)) {
    // The index, and the shared part a split index names.
    if (name === "HEAD" || name === "index" || name.startsWith("sharedindex.")) {
      await Fs.copyFile(NodePath.join(own, name), NodePath.join(store, name))
    }
  }
  // A submodule's store says where its working tree is. The copy's is where the copy is.
  await git(tree, ["config", "--unset", "core.worktree"]).catch(() => undefined)
}

/**
 * Makes a machine: removes what an earlier build left where it goes, copies
 * the workspace at `root` into its tree, and makes its home and its
 * temporary directory.
 *
 * The tree holds what `held` names, a fresh checkout, with a repository of
 * its own. A workspace that is no git checkout is copied whole, apart from
 * the cache directory and a `.jj` store, which two working copies cannot
 * share. The home starts with a copy of `homeTemplate` when one is given,
 * and with `links`: each is a path under the home and the directory it leads
 * to, which puts a version manager's home where its shims look for it.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const make = async (
  options: Start & {
    readonly machine: Machine
    readonly git?: Git | undefined
  }
): Promise<Machine> => {
  const { held, machine, root } = options
  await remove(machine.directory)
  await Fs.mkdir(machine.tree, { recursive: true })
  await Fs.mkdir(machine.tmp, { recursive: true })
  if (held === undefined) {
    const skipped = new Set([NodePath.join(root, ...options.cacheDirectory.split("/")), NodePath.join(root, ".jj")])
    await Fs.cp(root, machine.tree, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => !skipped.has(source)
    })
  } else {
    // Parents come before what they hold.
    for (const directory of [...held.directories].sort()) {
      await Fs.mkdir(NodePath.join(machine.tree, ...directory.split("/")))
    }
    await inBatches(
      [...held.files],
      (name) => copy(NodePath.join(root, ...name.split("/")), NodePath.join(machine.tree, ...name.split("/")))
    )
    await repository(root, machine.tree, options.git ?? PackageTree.runGit)
  }
  if (options.homeTemplate === undefined) await Fs.mkdir(machine.home, { recursive: true })
  else await Fs.cp(options.homeTemplate, machine.home, { recursive: true, verbatimSymlinks: true })
  for (const link of options.links ?? []) {
    const path = NodePath.join(machine.home, link.path)
    await Fs.mkdir(NodePath.dirname(path), { recursive: true })
    await Fs.symlink(link.target, path).catch(() => undefined)
  }
  return machine
}

/**
 * What a target that runs on a machine is told in place of the host's
 * values: its home, its cache directory, its temporary directory, and where
 * git stops looking for a repository above its tree.
 *
 * @category rendering
 * @since 1.0.0
 */
export const environment = (machine: Machine): Readonly<Record<string, string>> => ({
  HOME: machine.home,
  XDG_CACHE_HOME: NodePath.join(machine.home, ".cache"),
  TMPDIR: machine.tmp,
  TMP: machine.tmp,
  TEMP: machine.tmp,
  GIT_CEILING_DIRECTORIES: NodePath.dirname(machine.tree)
})

/**
 * A command word or a variable's value with the workspace's path replaced
 * by the machine's tree, so a program or a search path named inside the
 * workspace is the copy's. A path in the cache directory stays where it is:
 * the cache is the build's own, and a machine's tree has none.
 *
 * @category rendering
 * @since 1.0.0
 */
export const relocated = (value: string, root: string, tree: string, cacheDirectory: string): string => {
  const kept = `${root}/${cacheDirectory}`
  let moved = ""
  let from = 0
  for (let at = value.indexOf(root); at !== -1; at = value.indexOf(root, from)) {
    const after = value[at + root.length]
    const whole = after === undefined || after === "/" || after === ":"
    const cache = value.startsWith(kept, at) && (value[at + kept.length] === undefined ||
      value[at + kept.length] === "/" || value[at + kept.length] === ":")
    moved += value.slice(from, at) + (whole && !cache ? tree : root)
    from = at + root.length
  }
  return moved + value.slice(from)
}
