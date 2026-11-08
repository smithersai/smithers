// The platform code of changes.vibe: Node's files, git and jj subprocesses, which a .vibe file does not import.
import * as Log from "./log.ts"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, realpathSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import * as Subprocess from "./subprocess.ts"

export const maxBytes = 512_000
/** A text file's content; `null` when absent, `undefined` when unreadable, binary or large. */
export const read = async (path: string): Promise<string | null | undefined> => {
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > maxBytes) return undefined
      const bytes = await file.readFile()
      if (bytes.includes(0)) return undefined
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } finally {
      await file.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? null : undefined
  }
}
/** A file's permission bits; `undefined` when absent or unreadable. */
export const mode = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return undefined
  }
}
export interface FileState {
  readonly digest: string | null | undefined
  readonly text: string | null | undefined
  readonly mode: number | undefined
}
/** Read a candidate before or after the call; a digest covers binary and large files too. */
export const fileState = async (path: string): Promise<FileState> => {
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile()) return { digest: undefined, text: undefined, mode: undefined }
      const hash = createHash("sha256")
      let text: string | null | undefined
      if (info.size <= maxBytes) {
        const bytes = await file.readFile()
        hash.update(bytes)
        try {
          text = bytes.includes(0) ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        } catch {
          text = undefined
        }
      } else {
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
      }
      return { digest: hash.digest("hex"), text, mode: info.mode & 0o777 }
    } finally {
      await file.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR"
      ? { digest: null, text: null, mode: undefined }
      : { digest: undefined, text: undefined, mode: undefined }
  }
}
/** `program`'s standard output, in `cwd`; `undefined` when it fails, runs over 5 s or writes over 4 MB. */
export const command = async (
  program: string,
  cwd: string,
  args: Array<string>,
  env: Record<string, string> = {}
): Promise<string | undefined> => {
  try {
    const child = Subprocess.spawn([program, ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env }
    })
    const timer = setTimeout(() => child.kill(), 5000)
    try {
      const decoder = new TextDecoder()
      let output = ""
      const reader = child.stdout.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
        if (output.length > 4_000_000) {
          child.kill()
          return undefined
        }
      }
      output += decoder.decode()
      return await child.exited === 0 ? output : undefined
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    Log.write("changes.command", error)
    return undefined
  }
}
const git = (cwd: string, args: Array<string>, env?: Record<string, string>) => command("git", cwd, args, env)

/**
 * Whether `jj` resolves on this process's `PATH`.
 * @throws {never}
 */
export function hasJj(): boolean {
  return Subprocess.which("jj", process.env) !== null
}

/**
 * `path` resolved against `cwd`.
 * @throws {never}
 */
export function resolveIn(cwd: string, path: string): string {
  return resolve(cwd, path)
}

/**
 * Candidate files in the working tree, including untracked paths, without
 * staging or consulting HEAD. Ignored files are not candidates for receipts.
 */
export const gitPaths = async (cwd: string): Promise<Array<string> | undefined> => {
  const output = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."])
  return output === undefined ? undefined : [...new Set(output.split("\0").filter(Boolean))]
}
export const states = async (cwd: string, paths: ReadonlyArray<string>): Promise<Map<string, FileState>> => {
  const found = new Map<string, FileState>()
  for (let at = 0; at < paths.length; at += 64) {
    const batch = await Promise.all(
      paths.slice(at, at + 64).map(async (path) => [path, await fileState(resolve(cwd, path))] as const)
    )
    for (const [path, state] of batch) found.set(path, state)
  }
  return found
}

export interface FileStat {
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
  readonly ino: bigint
  readonly mode: bigint
}
const fileStat = async (path: string): Promise<FileStat | null | undefined> => {
  try {
    const info = await stat(path, { bigint: true })
    return { size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, ino: info.ino, mode: info.mode }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? null : undefined
  }
}
export const stats = async (
  cwd: string,
  paths: ReadonlyArray<string>
): Promise<Map<string, FileStat | null | undefined>> => {
  const found = new Map<string, FileStat | null | undefined>()
  for (let at = 0; at < paths.length; at += 64) {
    const batch = await Promise.all(
      paths.slice(at, at + 64).map(async (path) => [path, await fileStat(resolve(cwd, path))] as const)
    )
    for (const [path, info] of batch) found.set(path, info)
  }
  return found
}

/**
 * Paths with pre-call bytes that differ from the index, including untracked
 * files, relative to `cwd`: `git status` names them from the repository root.
 */
export const dirtyPaths = async (cwd: string): Promise<Array<string> | undefined> => {
  const prefix = await git(cwd, ["rev-parse", "--show-prefix"])
  const output = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])
  if (prefix === undefined || output === undefined) return undefined
  const under = prefix.replace(/\n$/, "")
  const entries = output.split("\0").filter(Boolean)
  const paths: Array<string> = []
  for (let at = 0; at < entries.length; at++) {
    const entry = entries[at]!
    const path = entry.slice(3)
    if (path.startsWith(under)) paths.push(path.slice(under.length))
    if (entry[0] === "R" || entry[1] === "R" || entry[0] === "C" || entry[1] === "C") at++
  }
  return paths
}

export const indexBlobs = async (cwd: string): Promise<Map<string, string> | undefined> => {
  const output = await git(cwd, ["ls-files", "--stage", "-z", "--", "."])
  if (output === undefined) return undefined
  const blobs = new Map<string, string>()
  for (const entry of output.split("\0").filter(Boolean)) {
    const match = entry.match(/^\d+ ([a-f0-9]+) 0\t(.+)$/s)
    if (match !== null) blobs.set(match[2]!, match[1]!)
  }
  return blobs
}

/** Recover a clean tracked file's pre-call bytes from the index only when its stat changed. */
export const indexState = async (cwd: string, blob: string, before: FileStat): Promise<FileState> => {
  if (before.size > BigInt(maxBytes)) {
    return { digest: `index:${blob}`, text: undefined, mode: Number(before.mode & 0o777n) }
  }
  const bytes = await new Promise<Buffer | undefined>((done) =>
    execFile(
      "git",
      ["cat-file", "blob", blob],
      { cwd, encoding: "buffer", maxBuffer: maxBytes + 1 },
      (error, output) => done(error ? undefined : Buffer.isBuffer(output) ? output : Buffer.from(output))
    )
  )
  if (bytes === undefined) return { digest: undefined, text: undefined, mode: Number(before.mode & 0o777n) }
  let text: string | undefined
  try {
    text = bytes.includes(0) ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    text = undefined
  }
  return { digest: createHash("sha256").update(bytes).digest("hex"), text, mode: Number(before.mode & 0o777n) }
}

/**
 * A named file as a shell receipt names it: relative to the workspace, else
 * absolute. `./a.ts`, `/repo/a.ts` and `a.ts` are then one file of a run.
 * @throws {never}
 */
export function within(cwd: string, path: string): string {
  const full = resolve(cwd, path)
  const roots = [resolve(cwd)]
  try {
    roots.push(realpathSync(cwd))
  } catch {
    // An unreadable workspace keeps its spelled root.
  }
  for (const root of roots) {
    const inside = relative(root, full)
    if (inside !== "" && inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside)) return inside
  }
  return full
}
