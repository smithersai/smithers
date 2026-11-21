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

import * as Data from "effect/Data"
import { execFile, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
import * as NodePath from "node:path"
import * as PackageTree from "../PackageTree.ts"
import * as ObservedReads from "./ObservedReads.ts"
import { byCodeUnit } from "./Text.ts"

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
 * The variable a target on a machine finds the machine's temporary directory
 * by, also when the target sets `TMPDIR` itself. What a tool keeps there for
 * the later targets of its machine is gone with the machine, where a file
 * under `/tmp` would still be there for the next build.
 *
 * @category constants
 * @since 1.0.0
 */
export const temporaryVariable = "SMTHRS_MACHINE_TMP"

/**
 * The names of directories under which a tool run in a checkout no longer
 * reads the checkout as written. Biome 2.6.6 skips every nested `biome.json`
 * of a project that lies under a directory with one of these names, so a lint
 * a CI passes fails on a machine kept there. No part of the path of a
 * machine's checkout has one of them.
 *
 * @category constants
 * @since 1.0.0
 */
export const skippedNames: ReadonlyArray<string> = [".cache", ".git", ".hg", ".output", ".svn", ".yarn", "node_modules"]

/**
 * The first part of `path` that is one of {@link skippedNames}, if any.
 *
 * @category resolution
 * @since 1.0.0
 */
export const skippedPart = (path: string): string | undefined =>
  path.split(/[\\/]+/).find((part) => skippedNames.includes(part))

/** The XDG base directory the variable `name` names, when it names an absolute one. */
const xdg = (environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined => {
  const value = environment[name]
  return value !== undefined && NodePath.isAbsolute(value) ? value : undefined
}

/** The directory inside `base`, named by the workspace's path, that holds the workspace's machines. */
const forWorkspace = (base: string, root: string): string =>
  NodePath.join(base, createHash("sha256").update(root).digest("hex").slice(0, 16))

/**
 * Where the machines of the workspace at `root` are kept: one directory for
 * the workspace, named by its path, outside the workspace. A tool that walks
 * up from a machine's copy so never finds a file of the workspace itself.
 * The directory is the same in every build of the workspace, because a
 * record of what a run read names the paths of its home.
 *
 * It is under the user's state directory (`$XDG_STATE_HOME/smthrs/machines`,
 * else `~/.local/state/smthrs/machines`), never the cache directory: Biome
 * does not read a checkout under `~/.cache` as written ({@link skippedNames}).
 *
 * @category resolution
 * @since 1.0.0
 */
export const holding = (root: string, environment: Readonly<Record<string, string | undefined>>): string =>
  forWorkspace(
    environment[holdingVariable] ??
      NodePath.join(
        xdg(environment, "XDG_STATE_HOME") ?? NodePath.join(environment["HOME"] as string, ".local", "state"),
        "smthrs",
        "machines"
      ),
    root
  )

/**
 * Where builds kept the machines of the workspace at `root` before they
 * moved out of the user's cache directory, when the environment names one.
 *
 * @category resolution
 * @since 1.0.0
 */
export const formerHolding = (
  root: string,
  environment: Readonly<Record<string, string | undefined>>
): string | undefined => {
  const cache = xdg(environment, "XDG_CACHE_HOME") ??
    (environment["HOME"] === undefined ? undefined : NodePath.join(environment["HOME"], ".cache"))
  return cache === undefined ? undefined : forWorkspace(NodePath.join(cache, "smthrs", "machines"), root)
}

/** A directory of machines with a part in its path under which a tool skips a project's configuration. */
class MachinesUnderSkipped extends Data.TaggedError("smithers-build/MachinesUnderSkipped")<{
  readonly message: string
}> {}

/** Fails when a part of `path`, the directory machines would be kept in, is one of {@link skippedNames}. */
const refuseSkipped = (path: string): void => {
  const part = skippedPart(path)
  if (part === undefined) return
  throw new MachinesUnderSkipped({
    message: `machines would be kept in ${path}, under a directory named ${part}, where tools such as Biome ` +
      `skip a project's own configuration files. Set ${holdingVariable} to a directory with no part named ` +
      `${skippedNames.join(", ")}.`
  })
}

/** Removes `kept`, and what a build set aside of it to be removed whose removal was stopped with the build's host. */
const clear = async (kept: string): Promise<void> => {
  await remove(kept)
  const beside = NodePath.dirname(kept)
  for (const name of await Fs.readdir(beside).catch(() => [])) {
    if (name.startsWith(`${NodePath.basename(kept)}${setAside}`)) await remove(NodePath.join(beside, name))
  }
}

/**
 * Makes the directory the machines of the workspace at `root` are kept in,
 * empty: what an earlier build left there, or in the place builds kept them
 * before ({@link formerHolding}), is removed. Answers its real path. Fails,
 * before anything is removed, when a part of the path is one of
 * {@link skippedNames}.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const prepare = async (
  root: string,
  environment: Readonly<Record<string, string | undefined>>
): Promise<string> => {
  const kept = holding(root, environment)
  refuseSkipped(kept)
  const former = formerHolding(root, environment)
  if (former !== undefined) await clear(former)
  await clear(kept)
  await Fs.mkdir(kept, { recursive: true })
  const real = await Fs.realpath(kept)
  refuseSkipped(real)
  return real
}

/**
 * What a build says when another build of the same workspace uses its
 * machines and it waits for that one to end ({@link hold}).
 *
 * @category constants
 * @since 1.0.0
 */
export const waitingLine = "smthrs: another run uses this checkout's machines; waiting for it to end"

/**
 * A build's hold on the machines of its workspace ({@link hold}).
 *
 * @category models
 * @since 1.0.0
 */
export interface Held {
  /** Ends the hold, and a build that waits for it goes on. */
  readonly release: () => Promise<void>
}

/** Machines kept where no hold on them can be named. */
class MachinesPathTooLong extends Data.TaggedError("smithers-build/MachinesPathTooLong")<{
  readonly message: string
}> {}

/**
 * Where the hold on the machines kept in `kept` is: a socket beside them,
 * which no build removes with them. A system takes a socket path of a little
 * over 100 bytes, and a build run on a machine keeps its own machines under
 * that machine's home, deeper than that: on Linux such a hold is a socket
 * named apart from the file system, and elsewhere the build fails and says
 * what to set.
 *
 * @category resolution
 * @since 1.0.0
 */
export const holdPath = (kept: string, platform: NodeJS.Platform = process.platform): string => {
  const path = `${kept}.lock`
  if (Buffer.byteLength(path) <= (platform === "linux" ? 107 : 103)) return path
  if (platform === "linux") return `\0smthrs-machines-${createHash("sha256").update(kept).digest("hex")}`
  throw new MachinesPathTooLong({
    message: `machines would be kept in ${kept}, a path too long for a socket that holds them while a build ` +
      `uses them. Set ${holdingVariable} to a shorter directory.`
  })
}

/** Listens on the socket at `path`: the server, or nothing when the path is taken. */
const listen = (path: string): Promise<Net.Server | undefined> =>
  new Promise((resolve, reject) => {
    const server = Net.createServer()
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(undefined)
      else reject(error)
    })
    server.listen(path, () => resolve(server))
  })

/** The connection to whoever listens on the socket at `path`, or nothing when nobody does. */
const answering = (path: string): Promise<Net.Socket | undefined> =>
  new Promise((resolve) => {
    const socket = Net.connect(path)
    socket.once("connect", () => resolve(socket))
    // Also a reset once connected, which ends the connection as its close does.
    socket.once("error", () => resolve(undefined))
  })

/** Resolves once `connection` is closed: the build at its other end has released its hold or ended. */
const closed = (connection: Net.Socket, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const stop = (): void => {
      connection.destroy()
      reject(signal!.reason)
    }
    signal?.addEventListener("abort", stop, { once: true })
    connection.once("close", () => {
      signal?.removeEventListener("abort", stop)
      resolve()
    })
  })

/**
 * Takes away a hold at `path` whose build ended without releasing it, as one that was killed does: its socket
 * is still there and nobody listens on it. It is moved aside first, so two builds that both found it so never
 * remove what a third took meanwhile; a socket that answers once moved aside is put back.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const unstale = async (path: string): Promise<void> => {
  const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString("hex")}`
  // Gone already: another build took it away.
  if (!(await Fs.rename(path, aside).then(() => true, () => false))) return
  const answer = await answering(aside)
  if (answer !== undefined) {
    answer.destroy()
    await Fs.link(aside, path)
  }
  await Fs.rm(aside, { force: true })
}

/**
 * Holds the machines of the workspace at `root` for one build until it
 * releases them or ends. Two builds of one workspace at once would each empty
 * and make the same machines, and a step of one would fail on a checkout the
 * other removed, so a second build waits here for the first to end, and says
 * so once with `waiting`. The hold is a socket the build listens on beside
 * where the machines are kept: the system closes it when the build ends,
 * however it ends, and a waiting build connected to it learns so at once. A
 * build that waits stops when `signal` is aborted.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const hold = async (
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  waiting: () => void,
  signal?: AbortSignal
): Promise<Held> => {
  const kept = holding(root, environment)
  refuseSkipped(kept)
  const path = holdPath(kept)
  await Fs.mkdir(NodePath.dirname(kept), { recursive: true })
  let said = false
  for (;;) {
    signal?.throwIfAborted()
    const server = await listen(path)
    if (server !== undefined) return held(server)
    const other = await answering(path)
    if (other === undefined) {
      await unstale(path)
      continue
    }
    if (!said) waiting()
    said = true
    await closed(other, signal)
  }
}

/** The hold of a build that listens on `server`: the builds waiting for it are connected until it is released. */
const held = (server: Net.Server): Held => {
  const waiters = new Set<Net.Socket>()
  server.on("connection", (waiter) => {
    const forget = (): void => {
      waiters.delete(waiter)
    }
    waiters.add(waiter)
    // A connection that fails is closed next: either way the build at its other end waits no more.
    waiter.on("error", forget)
    waiter.on("close", forget)
    waiter.unref()
  })
  server.unref()
  return {
    release: () =>
      new Promise((resolve) => {
        // Closing the server removes its socket.
        server.close(() => resolve())
        for (const waiter of waiters) waiter.destroy()
      })
  }
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

/** A path a machine does not have, with the code a missing file carries. */
class MachinePathMissing extends Data.TaggedError("smithers-build/MachinePathMissing")<{
  readonly message: string
  readonly code: "ENOENT"
}> {}

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
  const missing = (path: string): MachinePathMissing =>
    new MachinePathMissing({ message: `ENOENT: no such file or directory, lstat '${path}'`, code: "ENOENT" })
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

/**
 * The calls that remove a directory. A caller that needs another answer from one of them passes its own.
 *
 * @category models
 * @since 1.0.0
 */
export type Removal = Pick<typeof Fs, "lstat" | "chmod" | "readdir" | "rm">

/** Passes over a path that is gone: whoever took it away did what was wanted. Any other failure is thrown. */
const gone = (error: NodeJS.ErrnoException): undefined => {
  if (error.code !== "ENOENT") throw error
  return undefined
}

/**
 * Makes every directory under `path` one its owner can list and write, so that it can be removed. Another
 * remover can be at work on the same directory, as the command a build left to remove its machines is when the
 * next build starts: a directory it takes away between two calls here is passed over.
 */
const unlock = async (path: string, fs: Removal): Promise<void> => {
  const stats = await fs.lstat(path).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) return
  await fs.chmod(path, stats.mode | 0o700).catch(gone)
  for (const name of await fs.readdir(path).catch(gone) ?? []) await unlock(NodePath.join(path, name), fs)
}

/**
 * Removes a machine, or every machine kept in a directory. A tool can leave
 * a directory nothing can be removed from, as Go leaves its module cache, so
 * directories are made writable first.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const remove = async (directory: string, fs: Removal = Fs): Promise<void> => {
  try {
    await fs.rm(directory, { recursive: true, force: true })
  } catch {
    await unlock(directory, fs)
    await fs.rm(directory, { recursive: true, force: true })
  }
}

/** What follows the name of a directory of machines that a build set aside to be removed. */
const setAside = ".gone-"

/**
 * The command that removes a directory and everything in it, also where a
 * tool left a directory nothing can be removed from.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const remover = (directory: string): readonly [string, ...Array<string>] => [
  "/bin/sh",
  "-c",
  "rm -rf \"$1\" 2>/dev/null || { chmod -R u+rwx \"$1\" 2>/dev/null; rm -rf \"$1\"; }",
  "sh",
  directory
]

/**
 * Starts a command that nobody waits for: it goes on when this program ends.
 * `failed` is called when the command could not be started.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const startApart = (argv: readonly [string, ...Array<string>], failed: () => void): void => {
  const [program, ...rest] = argv
  const child = spawn(program, rest, { detached: true, stdio: "ignore" })
  child.on("error", failed)
  child.unref()
}

/**
 * Removes the directory a build's machines were kept in, without the build
 * waiting for it. The machines of a job hold everything the job installed
 * and built, and removing them took a second of a run that had nothing left
 * to do: on a CI runner, which is thrown away, a second nobody needed.
 *
 * The directory is renamed first, so it is gone for whatever looks next, and
 * a command that nobody waits for removes it. Where that command is stopped
 * with the build's host, as in a jail, the next build of the workspace
 * removes what is left ({@link prepare}). Windows has no such command, and a
 * directory that cannot be renamed is removed here and now.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const discard = async (
  directory: string,
  start: typeof startApart = startApart,
  platform: NodeJS.Platform = process.platform
): Promise<void> => {
  if (platform === "win32") return remove(directory)
  const gone = `${directory}${setAside}${process.pid}-${randomBytes(4).toString("hex")}`
  try {
    await Fs.rename(directory, gone)
  } catch {
    return remove(directory)
  }
  start(remover(gone), () => {
    void remove(gone).catch(() => undefined)
  })
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
 * values: its home, its cache, configuration, data and state directories
 * (under that home, where a tool looks when none is named), its temporary
 * directory, and where git stops looking for a repository above its tree. A
 * host's own `XDG_CONFIG_HOME` would otherwise reach every machine, and what
 * one machine's tool wrote there another would read. The temporary directory
 * is also named by `temporaryVariable`, which a target has no reason to set.
 *
 * @category rendering
 * @since 1.0.0
 */
export const environment = (machine: Machine): Readonly<Record<string, string>> => ({
  HOME: machine.home,
  XDG_CACHE_HOME: NodePath.join(machine.home, ".cache"),
  XDG_CONFIG_HOME: NodePath.join(machine.home, ".config"),
  XDG_DATA_HOME: NodePath.join(machine.home, ".local", "share"),
  XDG_STATE_HOME: NodePath.join(machine.home, ".local", "state"),
  TMPDIR: machine.tmp,
  TMP: machine.tmp,
  TEMP: machine.tmp,
  [temporaryVariable]: machine.tmp,
  GIT_CEILING_DIRECTORIES: NodePath.dirname(machine.tree)
})

/**
 * The variable that says two machines must never share a `/tmp`: set to
 * `required`, a build on a host that gives a machine no `/tmp` of its own
 * runs the targets of one machine there and fails the targets of every other
 * machine, with the reason. Without it they share the host's `/tmp` and the
 * build says so. A workflow that runs the jobs of a CI on one runner sets it:
 * two jobs of a CI never share a `/tmp`.
 *
 * @category constants
 * @since 1.0.0
 */
export const ownTmpVariable = "SMTHRS_MACHINE_OWN_TMP"

/**
 * Why a target of `machine` cannot run where the host gives no `/tmp` of its
 * own and `other`, another machine, has used the host's in this build.
 *
 * @category rendering
 * @since 1.0.0
 */
export const sharedRefusal = (machine: string, other: string, reason: string): string =>
  `machine ${machine} needs a ${sharedTmp} of its own, and this host gives none (${reason}); ` +
  `machine ${other} has used the host's in this build, so it would see what that one left there`

/**
 * The directory every program finds its temporary files in when it names
 * none: a program that writes `/tmp/x` asks for no `TMPDIR`.
 *
 * @category constants
 * @since 1.0.0
 */
export const sharedTmp = "/tmp"

/**
 * The entries of `/tmp` that hold one of `paths`, each once: `/tmp/work` for
 * `/tmp/work/home/x`. A build can keep its workspace, its machines or its
 * tools under `/tmp`, as a program that works in a temporary directory does,
 * and a target that finds another directory at `/tmp` must still find them.
 *
 * An entry that is not there is left out: bubblewrap refuses to put back a
 * path it cannot find, and a `PATH` can name one. npx puts the
 * `node_modules/.bin` of every directory above the one it starts in on
 * `PATH`, so a build started under `/tmp` names `/tmp/node_modules`.
 *
 * @category resolution
 * @since 1.0.0
 */
export const inSight = (
  paths: ReadonlyArray<string>,
  exists: (path: string) => boolean = NodeFs.existsSync
): ReadonlyArray<string> =>
  [
    ...new Set(paths.flatMap((path) => {
      const name = path.startsWith(`${sharedTmp}/`) ? path.slice(sharedTmp.length + 1).split("/")[0]! : ""
      return name === "" ? [] : [`${sharedTmp}/${name}`]
    }))
  ].filter(exists).sort(byCodeUnit)

/**
 * The command that runs `argv` with the machine's temporary directory in
 * place of `/tmp`, through `bwrap`, a bubblewrap that starts on this host
 * ({@link mounting}). Every other path is the host's, as it is without, and
 * so is each entry of `/tmp` in `sight` ({@link inSight}), put back where it
 * was. So a target that writes `/tmp/x` writes the machine's own, and the
 * targets of another machine never find it, as two jobs of a workflow never
 * share a `/tmp`.
 *
 * @category rendering
 * @since 1.0.0
 */
export const withOwnTmp = (
  bwrap: string,
  machine: Machine,
  argv: ReadonlyArray<string>,
  sight: ReadonlyArray<string> = []
): [string, ...Array<string>] => [
  bwrap,
  "--dev-bind",
  "/",
  "/",
  ...tmpBinds(machine, sight),
  "--die-with-parent",
  "--",
  ...argv
]

/**
 * The bubblewrap mounts that give a command the machine's temporary
 * directory at `/tmp`, with each entry of `sight` put back where it was
 * ({@link withOwnTmp}).
 *
 * @category rendering
 * @since 1.0.0
 */
export const tmpBinds = (machine: Machine, sight: ReadonlyArray<string> = []): ReadonlyArray<string> => [
  "--bind",
  machine.tmp,
  sharedTmp,
  ...sight.flatMap((entry) => ["--bind", entry, entry])
]

/**
 * Why `bwrap` cannot hold a job's processes on this host, or `undefined`
 * when it can: start a command as the second process of a process namespace
 * of its own, with a `/proc` of that namespace, tried once in `directory`. A
 * container that gives no process a namespace of its own, or a jail that does
 * not nest one, cannot.
 *
 * @category resolution
 * @since 1.0.0
 */
export const keeping = async (
  bwrap: string,
  directory: string,
  environment: Readonly<Record<string, string | undefined>>
): Promise<string | undefined> => {
  const tried = [bwrap, "--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--die-with-parent", "--", "true"]
  const started = await new Promise<boolean>((resolve) => {
    execFile(
      tried[0]!,
      tried.slice(1),
      { cwd: directory, env: { PATH: environment["PATH"] }, timeout: 30_000 },
      (error) => {
        resolve(error === null)
      }
    )
  })
  return started ? undefined : `${bwrap} cannot give a process a process namespace of its own here`
}

/**
 * Waits until `child` listens on the socket `name` in `directory`: `true`
 * once the socket is there, `false` when the child ended first or did not
 * listen within `limitMs`.
 *
 * @category resolution
 * @since 1.0.0
 */
export const listening = async (
  directory: string,
  name: string,
  child: { readonly exitCode: number | null; readonly signalCode: string | null },
  limitMs = 10_000
): Promise<boolean> => {
  const until = Date.now() + limitMs
  for (;;) {
    if (NodeFs.existsSync(NodePath.join(directory, name))) return true
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > until) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Where a run that was given the machine's temporary directory at `/tmp`
 * found each directory, for the recorder: the entries in `sight` where they
 * are, and everything else under `/tmp` in the machine's temporary directory.
 * The first that holds a path says where it is.
 *
 * @category rendering
 * @since 1.0.0
 */
export const mountsOf = (
  tmp: string,
  sight: ReadonlyArray<string>
): ReadonlyArray<readonly [at: string, from: string]> => [
  ...sight.map((entry) => [entry, entry] as const),
  [sharedTmp, tmp]
]

/**
 * The bubblewrap on `PATH` that gives a command a `/tmp` of its own on this
 * host, tried once on `directory`, or why there is none: another system than
 * Linux, no `bwrap`, or a host that refuses an unprivileged process a mount
 * of its own, as a container often does.
 *
 * @category resolution
 * @since 1.0.0
 */
export const mounting = async (
  environment: Readonly<Record<string, string | undefined>>,
  directory: string,
  platform: string = process.platform
): Promise<{ readonly bwrap: string } | { readonly reason: string }> => {
  if (platform !== "linux") return { reason: `a private ${sharedTmp} needs bubblewrap, which runs only on Linux` }
  let bwrap: string | undefined
  for (const each of (environment["PATH"] ?? "").split(NodePath.delimiter)) {
    if (each === "") continue
    const candidate = NodePath.join(each, "bwrap")
    const found = await Fs.access(candidate, NodeFs.constants.X_OK).then(() => true, () => false)
    if (found) {
      bwrap = candidate
      break
    }
  }
  if (bwrap === undefined) return { reason: "bwrap is not on PATH (install the bubblewrap package)" }
  const tried = withOwnTmp(bwrap, { name: "", directory, tree: directory, home: directory, tmp: directory }, ["true"])
  const started = await new Promise<boolean>((resolve) => {
    execFile(tried[0], tried.slice(1), { env: { PATH: environment["PATH"] }, timeout: 30_000 }, (error) => {
      resolve(error === null)
    })
  })
  return started ? { bwrap } : { reason: `${bwrap} cannot give a process a mount of its own on this host` }
}

/**
 * A command word or a variable's value with the workspace's path replaced
 * by the machine's tree, so a program or a search path named inside the
 * workspace is the copy's. A path in the cache directory stays where it is:
 * the cache is the build's own, and a machine's tree has none. So `mark`,
 * the text a declaration writes for the cache directory, becomes the
 * workspace's cache directory here: left for later, it would be read from
 * the machine's tree, and what a target keeps there would go with the
 * machine.
 *
 * @category rendering
 * @since 1.0.0
 */
export const relocated = (
  value: string,
  root: string,
  tree: string,
  cacheDirectory: string,
  mark?: string
): string => {
  // Joined, not concatenated: a cache directory outside the workspace is a
  // leading run of `..` segments, which only a join resolves.
  const kept = NodePath.join(root, ...cacheDirectory.split("/"))
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
  const placed = moved + value.slice(from)
  // After the paths are moved: the mark's directory is under the workspace, and is not the copy's.
  return mark === undefined ? placed : placed.replaceAll(mark, kept)
}

/**
 * Where a record names a machine's own paths from: a path no host has. A
 * machine's directory is another in every checkout and on every host, so a
 * record that named it would answer only where its run happened.
 *
 * @category constants
 * @since 1.0.0
 */
export const anchor = "/smthrs-machine"

/**
 * How a record names the directory a workspace's machines are kept in, the
 * one above a machine's own. Its name on a host holds the workspace's path,
 * and a run looks at it whenever it makes a directory and its parents under
 * the machine's home or temporary directory, as `mkdir -p` does.
 *
 * @category constants
 * @since 1.0.0
 */
export const holder = "/smthrs-machines"

/**
 * A path of a machine written from the machine: `/smthrs-machine/home/.npmrc`
 * for a file of its home, and `/smthrs-machines` for the directory the
 * machine is kept in. Any other path is as it is. A path of the copy is
 * never given here: a record writes those from the copy's root.
 *
 * @category rendering
 * @since 1.0.0
 */
export const neutral = (machine: Machine) => (path: string): string =>
  under(path, machine.directory)
    ? `${anchor}${path.slice(machine.directory.length)}`
    : path === NodePath.dirname(machine.directory)
    ? holder
    : path

/**
 * Whether a name written from a machine is one the machine keeps for its
 * later targets: a path under its home or its temporary directory. What a
 * run left there is kept with what it left in its tree, and put back on the
 * next machine of that name, which starts with neither.
 *
 * @category resolution
 * @since 1.0.0
 */
export const own = (name: string): boolean => {
  const parts = name.split("/")
  return (name.startsWith(`${anchor}/home/`) || name.startsWith(`${anchor}/tmp/`)) && !name.includes("\0") &&
    !parts.includes("..") && !parts.slice(1).includes("")
}

/**
 * The path on this host that a record's path names: one written from the
 * machine is under the machine's directory, and the directory the machine is
 * kept in is the one above it.
 *
 * @category rendering
 * @since 1.0.0
 */
export const actual = (machine: Machine) => (path: string): string =>
  under(path, anchor)
    ? `${machine.directory}${path.slice(anchor.length)}`
    : path === holder
    ? NodePath.dirname(machine.directory)
    : path

/**
 * Reads that take each path through `place` first.
 *
 * @category rendering
 * @since 1.0.0
 */
export const through = (
  place: (path: string) => string,
  io: ObservedReads.Io = ObservedReads.defaultIo
): ObservedReads.Io => ({
  lstat: (path) => io.lstat(place(path)),
  readlink: (path) => io.readlink(place(path)),
  readdir: (path) => io.readdir(place(path)),
  readFile: (path) => io.readFile(place(path)),
  head: (path, length) => io.head(place(path), length)
})

/**
 * What a run on a machine read and left, with the machine's own paths
 * written from the machine ({@link neutral}). The record then holds no path
 * of this checkout, so it answers in another one that restored the cache,
 * and what the run left in the machine's home and temporary directory is
 * put back on a machine kept anywhere ({@link own}).
 *
 * @category recording
 * @since 1.0.0
 */
export const recorded = (observation: ObservedReads.Observation, machine: Machine): ObservedReads.Observation => {
  const name = neutral(machine)
  const written = <Row extends readonly [string, ...ReadonlyArray<unknown>]>(rows: ReadonlyArray<Row>): Array<Row> =>
    rows
      .map((row) => [name(row[0]), ...row.slice(1)] as unknown as Row)
      .sort((left, right) => byCodeUnit(left[0], right[0]))
  const { id: _id, ...read } = observation.record
  const body = {
    ...read,
    reads: written(read.reads),
    lists: written(read.lists),
    ...(read.given === undefined ? {} : { given: written(read.given) })
  }
  /** A path the run left or removed, as it is kept: one of the machine's home or temporary directory from the machine. */
  const kept = (path: string): string => own(name(path)) ? name(path) : path
  const left = observation.left === undefined || "refusal" in observation.left
    ? observation.left
    : {
      keep: observation.left.keep.map(kept),
      gone: observation.left.gone.map(kept),
      outside: written(observation.left.outside)
    }
  return {
    ...observation,
    record: { ...body, id: ObservedReads.idOf(body) },
    ...(left === undefined ? {} : { left })
  }
}
