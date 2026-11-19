/**
 * A confined run's declared files gathered into one private directory.
 *
 * Bubblewrap binds each declared path with three arguments and refuses more
 * than {@link ProcessSandbox.bubblewrapArgumentLimit} in all, so a target that
 * declares a few thousand files cannot run confined one bind at a time. Such a
 * run is given a directory instead, made in the host's temporary directory,
 * holding each of its declared files at its own path, and mounted at the
 * workspace root. The run sees exactly what the binds would have shown it.
 *
 * Without a scratch layer the mount is read-only and the files are hard links
 * to the workspace's own, or copies where a link cannot be made (another
 * filesystem). With one the mount is writable, so a tool's stray write lands
 * in the directory and goes with it, and the files are copies without write
 * permission: a link there would let a write reach the workspace's file.
 *
 * The directory lives outside the workspace: every confined run can write the
 * cache directory, and a copy there would let one run read another's files. A
 * confined run is given its own empty `/tmp`, so it cannot see the host's.
 * The directory is removed when the run ends, and by a small reaper process
 * when the program that made it dies first, killed or not.
 *
 * @since 1.0.0
 */

import type * as ProcessSandbox from "@smthrs/platform-node/ProcessSandbox"
import { bubblewrapArgumentLimit, unenforceable } from "@smthrs/platform-node/ProcessSandbox"
import * as NodeChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"

/**
 * The longest command a run starts without a stage, in bytes. Linux refuses a
 * single command over a few megabytes (`E2BIG`), with the environment
 * counted against the same budget.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumCommandBytes = 1024 * 1024

/**
 * The host operations a stage is made with. The live ones touch the real file
 * system; a test passes one that fails to see each failure handled.
 *
 * @category models
 * @since 1.0.0
 */
export interface Io {
  /** Makes `to` a hard link to `from`. */
  readonly link: (from: string, to: string) => void
  /** Copies `from` to `to` with its bytes and mode. */
  readonly copy: (from: string, to: string) => void
  /** Removes a directory and everything in it. */
  readonly remove: (directory: string) => void
  /** Starts the reaper of `directory`; the answer stops it. */
  readonly reap: (directory: string) => () => void
}

/**
 * Starts a process that removes `directory` once its input pipe closes: when
 * the answer is called, or when this process dies and the kernel closes the
 * pipe for it. It is given no environment, so it holds none of the run's
 * variables. A reaper that cannot start leaves removal to the answer alone.
 *
 * @category constructors
 * @since 1.0.0
 */
export const reaper = (directory: string, shell = "/bin/sh"): () => void => {
  const child = NodeChildProcess.spawn(
    shell,
    ["-c", "cat > /dev/null; exec rm -rf -- \"$1\"", "smthrs-stage-reaper", directory],
    { cwd: "/", detached: true, env: {}, stdio: ["pipe", "ignore", "ignore"] }
  )
  child.on("error", () => undefined)
  child.unref()
  ;(child.stdin as unknown as { unref: () => void }).unref()
  return () => {
    child.stdin.destroy()
  }
}

/**
 * The live host operations.
 *
 * @category constructors
 * @since 1.0.0
 */
export const liveIo: Io = {
  link: (from, to) => NodeFs.linkSync(from, to),
  copy: (from, to) => NodeFs.copyFileSync(from, to, NodeFs.constants.COPYFILE_FICLONE),
  remove: (directory) => NodeFs.rmSync(directory, { recursive: true, force: true }),
  reap: (directory) => reaper(directory)
}

/**
 * Whether a bubblewrap command is too long to start: more arguments than
 * bubblewrap accepts, or more bytes than {@link maximumCommandBytes}.
 *
 * @category predicates
 * @since 1.0.0
 */
export const exceeds = (argv: ReadonlyArray<string>): boolean =>
  argv.length > bubblewrapArgumentLimit ||
  argv.reduce((bytes, argument) => bytes + Buffer.byteLength(argument) + 1, 0) > maximumCommandBytes

/**
 * A made stage and how to remove it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Prepared {
  readonly stage: ProcessSandbox.Stage
  /** Removes the directory. Never throws: removal is best effort, and the reaper tries again. */
  readonly release: () => void
}

const inside = (parent: string, path: string): boolean => path === parent || path.startsWith(`${parent}/`)

/**
 * Makes the stage of a bubblewrap plan: each declared file inside the
 * workspace that no write covers and no hidden entry masks, each link no
 * remaining bind already holds, and an empty mount point for every path the
 * plan still binds inside the workspace, because a read-only mount cannot
 * gain one. A failure removes what was made and is raised.
 *
 * @category constructors
 * @since 1.0.0
 */
export const prepare = (plan: ProcessSandbox.Plan, io: Io = liveIo): Prepared => {
  const holder = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smthrs-stage-"))
  const stop = io.reap(holder)
  const release = (): void => {
    try {
      io.remove(holder)
    } catch {
      // The reaper removes it when the pipe closes below.
    }
    stop()
  }
  try {
    const root = plan.workspaceRoot
    const directory = NodePath.join(holder, "workspace")
    const writable = plan.scratch === true
    const at = (path: string): string => NodePath.join(directory, NodePath.relative(root, path))
    const covered = [...plan.writes, ...(plan.hidden?.paths ?? [])]
    const files: Array<string> = []
    const bound: Array<string> = [...plan.writes]
    NodeFs.mkdirSync(directory)
    for (const read of plan.reads) {
      if (!inside(root, read) || read === root) continue
      const status = NodeFs.statSync(read)
      if (!status.isFile() || covered.some((parent) => inside(parent, read))) {
        bound.push(read)
        mountPoint(at(read), status.isDirectory())
        continue
      }
      NodeFs.mkdirSync(NodePath.dirname(at(read)), { recursive: true })
      place(io, read, at(read), writable, status)
      files.push(read)
    }
    const links: Array<string> = []
    for (const link of plan.links ?? []) {
      if (bound.some((parent) => inside(parent, link.path))) continue
      NodeFs.mkdirSync(NodePath.dirname(at(link.path)), { recursive: true })
      NodeFs.symlinkSync(link.target, at(link.path))
      links.push(link.path)
    }
    const others = [
      ...plan.writes,
      ...(plan.hidden?.paths ?? []),
      ...(plan.hidden?.restored ?? []),
      plan.cwd
    ]
    for (const path of others) {
      if (!inside(root, path) || path === root) continue
      mountPoint(at(path), !NodeFs.existsSync(path) || NodeFs.statSync(path).isDirectory())
    }
    return { stage: { directory, writable, files, links }, release }
  } catch (cause) {
    release()
    throw cause
  }
}

/**
 * Renders a plan's command, staging its declared files first when the command
 * would be too long to start. The answer's `prepared`, when there is one, is
 * the caller's to release once the run ends. A command still too long once
 * staged (its remaining binds are directories and other grants) is refused.
 *
 * @category constructors
 * @since 1.0.0
 */
export const render = <W extends { readonly argv: ReadonlyArray<string> }>(
  plan: ProcessSandbox.Plan,
  wrap: (plan: ProcessSandbox.Plan) => W,
  io: Io = liveIo
): { readonly wrapped: W; readonly prepared?: Prepared } => {
  const wrapped = wrap(plan)
  if (plan.mechanism._tag !== "bubblewrap" || !exceeds(wrapped.argv)) return { wrapped }
  const prepared = prepare(plan, io)
  try {
    const staged = wrap({ ...plan, stage: prepared.stage })
    if (exceeds(staged.argv)) {
      throw unenforceable(
        "linux",
        "bubblewrap",
        "fewer bound paths",
        `the confined command still has ${staged.argv.length} arguments once its files are gathered in one ` +
          `directory; bubblewrap accepts ${bubblewrapArgumentLimit}`
      )
    }
    return { wrapped: staged, prepared }
  } catch (cause) {
    prepared.release()
    throw cause
  }
}

/** Puts one declared file in place: a hard link where it may be one, else a copy with the file's times. */
const place = (io: Io, from: string, to: string, writable: boolean, status: NodeFs.Stats): void => {
  if (!writable) {
    try {
      io.link(from, to)
      return
    } catch {
      // Another filesystem, or a file this user may not link: a copy shows the same bytes.
    }
  }
  io.copy(from, to)
  NodeFs.utimesSync(to, status.atime, status.mtime)
  if (writable) NodeFs.chmodSync(to, status.mode & 0o7555)
}

/** An empty directory or file where a later bind mounts, unless something is already there. */
const mountPoint = (path: string, directory: boolean): void => {
  if (NodeFs.existsSync(path)) return
  NodeFs.mkdirSync(directory ? path : NodePath.dirname(path), { recursive: true })
  if (!directory) NodeFs.writeFileSync(path, "")
}
