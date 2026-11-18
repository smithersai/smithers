/**
 * The content identity of an installed dependency tree.
 *
 * A confined tool run can read every package under the `node_modules`
 * directories above its working directory, so those bytes are part of what
 * decides its verdict. The lockfile names what an install should have put
 * there; this module measures what is there. A package patched in place, a
 * binary replaced without a version change and a link pointed elsewhere all
 * change the identity while the lockfile stays the same.
 *
 * A tree is measured as units: its `.bin` directory, each child of a pnpm
 * virtual store (`.pnpm/<id>`), and each other entry whose name does not start
 * with a dot. The remaining dot entries are a tool's own scratch state
 * (`.vite`, `.cache`, the package manager's state files); a confined run is
 * not shown them, so they are not key material.
 *
 * Reading 2.5 GB to key one plan is too slow to repeat, so each unit's digest
 * is remembered beside a fingerprint of its entries' status: path, type, size,
 * mode, inode, device and both nanosecond timestamps. A unit whose
 * fingerprint is unchanged is not read again, which is the trust Git's index
 * places in the same fields. A unit changed less than two seconds before it
 * was read is never remembered, because a later write inside the same
 * timestamp tick would leave its status unchanged.
 *
 * @since 1.0.0
 */

import { createHash, randomBytes } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { byCodeUnit } from "./Text.ts"

/** The format tag a saved file carries; any other tag is ignored. */
const format = "smthrs-installed-trees/1"

/** The largest remembered file read; a larger one is ignored. */
const maximumBytes = 64 * 1024 * 1024

/**
 * Entries one tree may hold before measuring it fails.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumEntries = 4_000_000

/**
 * Directory depth one unit may reach before measuring it fails.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumDepth = 128

/** How recently a unit may have changed and still be remembered. */
const settledNanoseconds = 2_000_000_000n

const digestPattern = /^[0-9a-f]{64}$/

/** One remembered unit: the status fingerprint it was read at, and its content digest. */
interface Row {
  readonly fingerprint: string
  readonly digest: string
  readonly files: number
}

/**
 * Unit digests one invocation remembers for the next.
 *
 * @category models
 * @since 1.0.0
 */
export interface Remembered {
  readonly rows: Map<string, Row>
  changed: boolean
}

/**
 * The measured identity of one installed tree.
 *
 * @category models
 * @since 1.0.0
 */
export interface Identity {
  /** SHA-256 over every unit's name and content digest, in name order. */
  readonly digest: string
  readonly units: number
  readonly files: number
}

/**
 * What measuring a tree reads through; a test supplies a failing member.
 *
 * @category models
 * @since 1.0.0
 */
export interface Io {
  readonly readdir: (directory: string) => ReadonlyArray<NodeFs.Dirent>
  readonly lstat: (path: string) => NodeFs.BigIntStats
  readonly readlink: (path: string) => string
  readonly read: (path: string, onChunk: (chunk: Uint8Array) => void) => void
  readonly now: () => bigint
}

const readBuffer = Buffer.allocUnsafe(1024 * 1024)

/**
 * The host file system.
 *
 * @category constructors
 * @since 1.0.0
 */
export const defaultIo: Io = {
  readdir: (directory) => NodeFs.readdirSync(directory, { withFileTypes: true }),
  lstat: (path) => NodeFs.lstatSync(path, { bigint: true }),
  readlink: (path) => NodeFs.readlinkSync(path),
  read: (path, onChunk) => {
    const descriptor = NodeFs.openSync(path, NodeFs.constants.O_RDONLY | NodeFs.constants.O_NOFOLLOW)
    try {
      for (;;) {
        const count = NodeFs.readSync(descriptor, readBuffer, 0, readBuffer.length, null)
        if (count === 0) return
        onChunk(readBuffer.subarray(0, count))
      }
    } finally {
      NodeFs.closeSync(descriptor)
    }
  },
  now: () => process.hrtime.bigint() - hrtimeOrigin + wallOrigin
}

const hrtimeOrigin = process.hrtime.bigint()
const wallOrigin = BigInt(Date.now()) * 1_000_000n

/**
 * An empty memory: every unit is read.
 *
 * @category constructors
 * @since 1.0.0
 */
export const empty = (): Remembered => ({ rows: new Map(), changed: false })

/**
 * Where a workspace's remembered units live: `<cache directory>/plan/installed-trees.json`.
 *
 * @category paths
 * @since 1.0.0
 */
export const path = (root: string, cacheDirectory: string): string =>
  NodePath.join(root, ...cacheDirectory.split("/"), "plan", "installed-trees.json")

/**
 * Loads the remembered units. The file is a cache, never an authority: one
 * that is missing, unreadable, too large, malformed or of another format is
 * ignored and every unit is read again.
 *
 * @category persistence
 * @since 1.0.0
 */
export const load = async (file: string): Promise<Remembered> => {
  const remembered = empty()
  let text: string
  try {
    const stats = await Fs.stat(file)
    if (!stats.isFile() || stats.size > maximumBytes) return remembered
    text = await Fs.readFile(file, "utf8")
  } catch {
    return remembered
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return remembered
  }
  if (typeof parsed !== "object" || parsed === null) return remembered
  const document = parsed as { readonly format?: unknown; readonly rows?: unknown }
  if (document.format !== format || !Array.isArray(document.rows)) return remembered
  for (const entry of document.rows) {
    if (!Array.isArray(entry) || entry.length !== 4) continue
    const [unit, fingerprint, digest, files] = entry as ReadonlyArray<unknown>
    if (
      typeof unit === "string" && typeof fingerprint === "string" && digestPattern.test(fingerprint) &&
      typeof digest === "string" && digestPattern.test(digest) &&
      typeof files === "number" && Number.isSafeInteger(files) && files >= 0
    ) remembered.rows.set(unit, { fingerprint, digest, files })
  }
  return remembered
}

/**
 * Saves the remembered units when a measurement changed them. The bytes go to
 * a temporary file renamed into place, so a reader sees a whole file or the
 * previous one.
 *
 * @category persistence
 * @since 1.0.0
 */
export const save = async (file: string, remembered: Remembered): Promise<void> => {
  if (!remembered.changed) return
  const rows = [...remembered.rows].sort(([left], [right]) => byCodeUnit(left, right))
    .map(([unit, row]) => [unit, row.fingerprint, row.digest, row.files])
  const directory = NodePath.dirname(file)
  await Fs.mkdir(directory, { recursive: true })
  const temporary = NodePath.join(directory, `.installed-trees-${randomBytes(8).toString("hex")}.tmp`)
  try {
    await Fs.writeFile(temporary, JSON.stringify({ format, rows }), { flag: "wx" })
    await Fs.rename(temporary, file)
  } catch (cause) {
    await Fs.rm(temporary, { force: true })
    throw cause
  }
  remembered.changed = false
}

interface Entry {
  readonly path: string
  readonly kind: "file" | "link" | "directory" | "other"
  readonly stats: NodeFs.BigIntStats
  readonly target: string | undefined
}

/**
 * How large a tree may be before measuring it fails.
 *
 * @category models
 * @since 1.0.0
 */
export interface Limits {
  readonly entries: number
  readonly depth: number
}

const defaultLimits: Limits = { entries: maximumEntries, depth: maximumDepth }

/** One unit's entries, in path order, without following a link. */
const list = (
  io: Io,
  root: string,
  limits: Limits,
  budget: { remaining: number }
): ReadonlyArray<Entry> => {
  const entries: Array<Entry> = []
  const visit = (absolute: string, relative: string, depth: number): void => {
    if (depth > limits.depth) throw new Error(`installed tree is deeper than ${limits.depth} directories: ${absolute}`)
    budget.remaining -= 1
    if (budget.remaining < 0) throw new Error(`installed tree holds more than ${limits.entries} entries`)
    const stats = io.lstat(absolute)
    if (stats.isSymbolicLink()) {
      entries.push({ path: relative, kind: "link", stats, target: io.readlink(absolute) })
    } else if (stats.isDirectory()) {
      entries.push({ path: relative, kind: "directory", stats, target: undefined })
      const names = io.readdir(absolute).map((entry) => entry.name).sort()
      for (const name of names) {
        visit(NodePath.join(absolute, name), relative === "" ? name : `${relative}/${name}`, depth + 1)
      }
    } else {
      entries.push({ path: relative, kind: stats.isFile() ? "file" : "other", stats, target: undefined })
    }
  }
  visit(root, "", 0)
  return entries
}

/** The status of a unit's entries; a directory's own timestamps move with its tool's scratch and are left out. */
const fingerprintOf = (entries: ReadonlyArray<Entry>): string => {
  const hash = createHash("sha256")
  for (const entry of entries) {
    const { stats } = entry
    hash.update(
      entry.kind === "directory"
        ? `d\0${entry.path}\0${stats.mode}\n`
        : `${entry.kind}\0${entry.path}\0${stats.mode}\0${stats.size}\0${stats.dev}\0${stats.ino}\0` +
          `${stats.mtimeNs}\0${stats.ctimeNs}\0${entry.target ?? ""}\n`
    )
  }
  return hash.digest("hex")
}

/** The content of a unit's entries: every file's bytes, every link's target, every name. */
const contentOf = (io: Io, root: string, entries: ReadonlyArray<Entry>): string => {
  const hash = createHash("sha256")
  for (const entry of entries) {
    if (entry.kind === "file") {
      const file = createHash("sha256")
      io.read(entry.path === "" ? root : NodePath.join(root, entry.path), (chunk) => file.update(chunk))
      const executable = (entry.stats.mode & 0o111n) === 0n ? "-" : "x"
      hash.update(`file\0${entry.path}\0${executable}\0${file.digest("hex")}\n`)
    } else hash.update(`${entry.kind}\0${entry.path}\0${entry.target ?? ""}\n`)
  }
  return hash.digest("hex")
}

/**
 * The content digest of one file, link or directory tree, read whole.
 *
 * The digest covers every name below `path`, every file's bytes and
 * executable bit, and every link's target. A path that does not exist
 * answers `"absent"`, which is an identity too: a result that ran without
 * the path is not reused once it appears.
 *
 * @category measuring
 * @since 1.0.0
 */
export const measure = (path: string, io: Io = defaultIo): string => {
  // Only the path itself may be absent. An entry that vanishes below it while
  // it is read is a tree that changed, and that fails.
  try {
    io.lstat(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "absent"
    throw cause
  }
  return contentOf(io, path, list(io, path, defaultLimits, { remaining: defaultLimits.entries }))
}

/**
 * The units of one installed tree, by name: `.bin`, each child of `.pnpm`,
 * and each entry whose name does not start with a dot.
 *
 * @category measuring
 * @since 1.0.0
 */
export const units = (directory: string, io: Io = defaultIo): ReadonlyArray<string> => {
  const names: Array<string> = []
  for (const entry of io.readdir(directory)) {
    if (entry.name === ".bin") names.push(entry.name)
    else if (entry.name === ".pnpm") {
      if (io.lstat(NodePath.join(directory, entry.name)).isDirectory()) {
        for (const child of io.readdir(NodePath.join(directory, entry.name))) names.push(`.pnpm/${child.name}`)
      } else names.push(entry.name)
    } else if (!entry.name.startsWith(".")) names.push(entry.name)
  }
  return names.sort()
}

/**
 * Measures one installed tree.
 *
 * `directory` is the absolute path of a `node_modules` directory. Links are
 * recorded by their target text and never followed, so a workspace package
 * linked into the tree contributes its link, not its sources: those are the
 * consumer's declared inputs. The call fails when the tree cannot be read
 * whole, and a caller that cannot identify a tree must not reuse a result
 * that read it.
 *
 * @category measuring
 * @since 1.0.0
 */
export const identify = (
  directory: string,
  remembered: Remembered = empty(),
  io: Io = defaultIo,
  limits: Limits = defaultLimits
): Identity => {
  const budget = { remaining: limits.entries }
  const hash = createHash("sha256")
  let files = 0
  let count = 0
  for (const unit of units(directory, io)) {
    const root = NodePath.join(directory, ...unit.split("/"))
    const entries = list(io, root, limits, budget)
    const fingerprint = fingerprintOf(entries)
    const known = remembered.rows.get(root)
    let row: Row
    if (known !== undefined && known.fingerprint === fingerprint) row = known
    else {
      const readAt = io.now()
      row = {
        fingerprint,
        digest: contentOf(io, root, entries),
        files: entries.filter((entry) => entry.kind === "file").length
      }
      const settled = entries.every((entry) =>
        entry.stats.mtimeNs + settledNanoseconds < readAt && entry.stats.ctimeNs + settledNanoseconds < readAt
      )
      if (settled) {
        remembered.rows.set(root, row)
        remembered.changed = true
      } else if (known !== undefined) {
        remembered.rows.delete(root)
        remembered.changed = true
      }
    }
    hash.update(`${unit}\0${row.digest}\n`)
    files += row.files
    count += 1
  }
  return { digest: hash.digest("hex"), units: count, files }
}
