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
 * A measurement keeps each unit's digest and the newest status change among
 * its entries. Two measurements of one tree can then say which unit differs,
 * and which entries in it were written after the first.
 *
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import { createHash, randomBytes } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { Worker } from "node:worker_threads"
import { byCodeUnit } from "./Text.ts"

/** A tree too deep or too large to measure. */
class InstalledTreeRefused extends Data.TaggedError("smithers-build/InstalledTreeRefused")<{
  readonly message: string
}> {}

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
 * One measured unit of an installed tree.
 *
 * @category models
 * @since 1.0.0
 */
export interface Unit {
  /** The unit's content digest. */
  readonly digest: string
  /**
   * The newest status change among the unit's entries when it was measured,
   * in nanoseconds since the epoch. The host sets that time on every write to
   * an entry, so an entry with a later one was written after the measurement.
   */
  readonly latest: bigint
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
  /** Each unit's measurement by name, which is what lets a later change be named. */
  readonly byUnit: ReadonlyMap<string, Unit>
}

/**
 * What changed in an installed tree between two measurements of it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Change {
  /** The first unit, in name order, that differs. */
  readonly unit: string
  /** Whether the unit appeared, disappeared, or holds different content. */
  readonly kind: "added" | "removed" | "written"
  /**
   * Paths inside a written unit whose status changed after the first
   * measurement, in path order and at most {@link maximumChangedPaths}. Empty
   * when no entry is newer than that measurement.
   */
  readonly paths: ReadonlyArray<string>
  /** How many more paths changed in the unit than `paths` names. */
  readonly morePaths: number
  /** How many more units differ. */
  readonly moreUnits: number
}

/**
 * Paths one {@link Change} names before it counts the rest.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumChangedPaths = 3

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
    if (depth > limits.depth) {
      throw new InstalledTreeRefused({
        message: `installed tree is deeper than ${limits.depth} directories: ${absolute}`
      })
    }
    budget.remaining -= 1
    if (budget.remaining < 0) {
      throw new InstalledTreeRefused({ message: `installed tree holds more than ${limits.entries} entries` })
    }
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
  const byUnit = new Map<string, Unit>()
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
    byUnit.set(unit, { digest: row.digest, latest: latestOf(entries) })
    files += row.files
    count += 1
  }
  return { digest: hash.digest("hex"), units: count, files, byUnit }
}

interface WorkerTask {
  readonly unit: string
  readonly knownFingerprint: string | undefined
}

type WorkerUnitOutcome =
  | {
    readonly hit: true
    readonly fingerprint: string
    readonly latest: bigint
    readonly entriesCount: number
  }
  | {
    readonly hit: false
    readonly fingerprint: string
    readonly digest: string
    readonly files: number
    readonly latest: bigint
    readonly settled: boolean
    readonly entriesCount: number
  }

interface WorkerResponse {
  readonly id: number
  readonly results?: ReadonlyArray<WorkerUnitOutcome>
  readonly error?: { readonly refused: boolean; readonly message: string; readonly code?: string }
}

interface PoolWorker {
  readonly worker: Worker
  readonly pending: Map<
    number,
    {
      readonly resolve: (results: ReadonlyArray<WorkerUnitOutcome>) => void
      readonly reject: (cause: unknown) => void
    }
  >
}

class InstalledTreeIoError
  extends Data.TaggedError("InstalledTreeIoError")<{ readonly message: string; readonly code?: string | undefined }>
{}
class InstalledTreeWorkerError extends Data.TaggedError("InstalledTreeWorkerError")<{ readonly message: string }> {}

const workerScript = `
import { parentPort } from "node:worker_threads";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { createHash } from "node:crypto";

const readBuffer = Buffer.allocUnsafe(1024 * 1024);
const hrOrigin = process.hrtime.bigint();
const wallOrigin = BigInt(Date.now()) * 1_000_000n;
const nowNs = () => process.hrtime.bigint() - hrOrigin + wallOrigin;

const scanUnit = (unitRoot, knownFingerprint, limits, settledNs) => {
  const fpHash = createHash("sha256");
  const collectRecords = knownFingerprint === undefined;
  const records = collectRecords ? [] : undefined;
  let latest = 0n;
  let maxMod = 0n;
  let entriesCount = 0;
  let filesCount = 0;

  const visit = (absolute, relative, depth) => {
    if (depth > limits.depth) {
      throw { refused: true, message: "installed tree is deeper than " + limits.depth + " directories: " + absolute };
    }
    entriesCount += 1;
    if (entriesCount > limits.entries) {
      throw { refused: true, message: "installed tree holds more than " + limits.entries + " entries" };
    }
    const stats = NodeFs.lstatSync(absolute, { bigint: true });
    if (stats.ctimeNs > latest) latest = stats.ctimeNs;
    if (stats.mtimeNs > maxMod) maxMod = stats.mtimeNs;
    if (stats.ctimeNs > maxMod) maxMod = stats.ctimeNs;
    if (stats.isSymbolicLink()) {
      const target = NodeFs.readlinkSync(absolute);
      fpHash.update(
        "link\\0" + relative + "\\0" + stats.mode + "\\0" + stats.size + "\\0" +
        stats.dev + "\\0" + stats.ino + "\\0" + stats.mtimeNs + "\\0" + stats.ctimeNs + "\\0" + target + "\\n"
      );
      if (records !== undefined) records.push({ path: relative, kind: "link", executable: "", target });
    } else if (stats.isDirectory()) {
      fpHash.update("d\\0" + relative + "\\0" + stats.mode + "\\n");
      if (records !== undefined) records.push({ path: relative, kind: "directory", executable: "", target: "" });
      const names = NodeFs.readdirSync(absolute).sort();
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        visit(NodePath.join(absolute, name), relative === "" ? name : relative + "/" + name, depth + 1);
      }
    } else {
      const isFile = stats.isFile();
      const kind = isFile ? "file" : "other";
      if (isFile) filesCount += 1;
      fpHash.update(
        kind + "\\0" + relative + "\\0" + stats.mode + "\\0" + stats.size + "\\0" +
        stats.dev + "\\0" + stats.ino + "\\0" + stats.mtimeNs + "\\0" + stats.ctimeNs + "\\0\\n"
      );
      if (records !== undefined) {
        records.push({
          path: relative,
          kind,
          executable: isFile ? ((stats.mode & 0o111n) === 0n ? "-" : "x") : "",
          target: ""
        });
      }
    }
  };

  visit(unitRoot, "", 0);
  const fingerprint = fpHash.digest("hex");
  if (knownFingerprint !== undefined && fingerprint === knownFingerprint) {
    return { hit: true, fingerprint, latest, entriesCount };
  }
  if (records === undefined) {
    return scanUnit(unitRoot, undefined, limits, settledNs);
  }
  const readAt = nowNs();
  const contentHash = createHash("sha256");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.kind === "file") {
      const fileHash = createHash("sha256");
      const abs = rec.path === "" ? unitRoot : NodePath.join(unitRoot, rec.path);
      const fd = NodeFs.openSync(abs, NodeFs.constants.O_RDONLY | NodeFs.constants.O_NOFOLLOW);
      try {
        for (;;) {
          const count = NodeFs.readSync(fd, readBuffer, 0, readBuffer.length, null);
          if (count === 0) break;
          fileHash.update(readBuffer.subarray(0, count));
        }
      } finally {
        NodeFs.closeSync(fd);
      }
      contentHash.update("file\\0" + rec.path + "\\0" + rec.executable + "\\0" + fileHash.digest("hex") + "\\n");
    } else {
      contentHash.update(rec.kind + "\\0" + rec.path + "\\0" + rec.target + "\\n");
    }
  }
  return {
    hit: false,
    fingerprint,
    digest: contentHash.digest("hex"),
    files: filesCount,
    latest,
    settled: maxMod + settledNs < readAt,
    entriesCount
  };
};

parentPort.on("message", ({ id, directory, tasks, limits, settledNs }) => {
  try {
    const results = new Array(tasks.length);
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const unitRoot = NodePath.join(directory, ...task.unit.split("/"));
      results[i] = scanUnit(unitRoot, task.knownFingerprint, limits, settledNs);
    }
    parentPort.postMessage({ id, results });
  } catch (cause) {
    parentPort.postMessage({
      id,
      error: {
        refused: Boolean(cause && cause.refused),
        message: cause instanceof Error ? cause.message : (cause && typeof cause.message === "string" ? cause.message : String(cause)),
        code: cause && typeof cause.code === "string" ? cause.code : undefined
      }
    });
  }
});
`

const workerUrl = new URL(`data:text/javascript;base64,${Buffer.from(workerScript, "utf8").toString("base64")}`)
let pool: Array<PoolWorker> | undefined
let nextRequestId = 1

const spawnPoolWorker = (): PoolWorker => {
  const worker = new Worker(workerUrl)
  worker.unref()
  const entry: PoolWorker = { worker, pending: new Map() }
  worker.on("message", (msg: WorkerResponse) => {
    const waiter = entry.pending.get(msg.id)
    if (waiter === undefined) return
    entry.pending.delete(msg.id)
    if (entry.pending.size === 0) worker.unref()
    if (msg.error !== undefined) {
      if (msg.error.refused) {
        waiter.reject(new InstalledTreeRefused({ message: msg.error.message }))
      } else {
        waiter.reject(new InstalledTreeIoError({ message: msg.error.message, code: msg.error.code }))
      }
      return
    }
    waiter.resolve(msg.results!)
  })
  const failAll = (cause: unknown): void => {
    if (pool !== undefined) {
      const idx = pool.indexOf(entry)
      if (idx >= 0) pool.splice(idx, 1)
    }
    for (const waiter of entry.pending.values()) waiter.reject(cause)
    entry.pending.clear()
  }
  worker.on("error", failAll)
  worker.on("exit", (code) => {
    if (entry.pending.size > 0) {
      failAll(new InstalledTreeWorkerError({ message: `installed-tree worker exited unexpectedly with code ${code}` }))
    }
  })
  return entry
}

const getPool = (needed: number): ReadonlyArray<PoolWorker> => {
  const targetSize = Math.min(needed, Math.min(8, Math.max(2, Os.availableParallelism())))
  if (pool === undefined) pool = []
  while (pool.length < targetSize) pool.push(spawnPoolWorker())
  return pool.slice(0, targetSize)
}

/**
 * Measures one installed tree asynchronously across worker threads when running
 * against the host filesystem with enough units to benefit from parallelism.
 *
 * Produces the exact same {@link Identity}, entry limits, and cache updates as
 * {@link identify}, falling back to synchronous execution for small trees or
 * custom {@link Io} implementations.
 *
 * @category measuring
 * @since 1.0.0
 */
export const identifyAsync = async (
  directory: string,
  remembered: Remembered = empty(),
  io: Io = defaultIo,
  limits: Limits = defaultLimits
): Promise<Identity> => {
  if (io !== defaultIo) return identify(directory, remembered, io, limits)
  const unitNames = units(directory, io)
  if (unitNames.length <= 8) return identify(directory, remembered, io, limits)

  const workers = getPool(unitNames.length)
  const batches: Array<Array<WorkerTask>> = Array.from({ length: workers.length }, () => [])
  const batchIndices: Array<Array<number>> = Array.from({ length: workers.length }, () => [])
  const unitRoots = new Array<string>(unitNames.length)
  for (let i = 0; i < unitNames.length; i++) {
    const unit = unitNames[i]!
    const root = NodePath.join(directory, ...unit.split("/"))
    unitRoots[i] = root
    const known = remembered.rows.get(root)
    const bucket = i % workers.length
    batches[bucket]!.push({ unit, knownFingerprint: known?.fingerprint })
    batchIndices[bucket]!.push(i)
  }

  const outcomes = new Array<WorkerUnitOutcome>(unitNames.length)
  await Promise.all(
    workers.map((pw, bucket) => {
      const tasks = batches[bucket]!
      if (tasks.length === 0) return Promise.resolve()
      const id = nextRequestId++
      pw.worker.ref()
      return new Promise<void>((resolve, reject) => {
        pw.pending.set(id, {
          resolve: (results) => {
            const indices = batchIndices[bucket]!
            for (let j = 0; j < results.length; j++) outcomes[indices[j]!] = results[j]!
            resolve()
          },
          reject
        })
        pw.worker.postMessage({ id, directory, tasks, limits, settledNs: settledNanoseconds })
      })
    })
  )

  let totalEntries = 0
  for (let i = 0; i < outcomes.length; i++) {
    totalEntries += outcomes[i]!.entriesCount
    if (totalEntries > limits.entries) {
      throw new InstalledTreeRefused({ message: `installed tree holds more than ${limits.entries} entries` })
    }
  }

  const hash = createHash("sha256")
  const byUnit = new Map<string, Unit>()
  let files = 0
  for (let i = 0; i < unitNames.length; i++) {
    const unit = unitNames[i]!
    const root = unitRoots[i]!
    const outcome = outcomes[i]!
    const known = remembered.rows.get(root)
    let row: Row
    if (outcome.hit && known !== undefined && known.fingerprint === outcome.fingerprint) {
      row = known
    } else if (!outcome.hit) {
      row = { fingerprint: outcome.fingerprint, digest: outcome.digest, files: outcome.files }
      if (outcome.settled) {
        remembered.rows.set(root, row)
        remembered.changed = true
      } else if (known !== undefined) {
        remembered.rows.delete(root)
        remembered.changed = true
      }
    } else {
      // Defensive fallback if `remembered.rows` mutated concurrently mid-scan.
      return identify(directory, remembered, io, limits)
    }
    hash.update(`${unit}\0${row.digest}\n`)
    byUnit.set(unit, { digest: row.digest, latest: outcome.latest })
    files += row.files
  }
  return { digest: hash.digest("hex"), units: unitNames.length, files, byUnit }
}

/** The newest status change among a unit's entries. */
const latestOf = (entries: ReadonlyArray<Entry>): bigint =>
  entries.reduce((latest, { stats }) => stats.ctimeNs > latest ? stats.ctimeNs : latest, 0n)

/**
 * Names what changed in a tree between two measurements, or nothing when the
 * two are the same tree.
 *
 * `before` is the earlier measurement, `after` a later one of the same
 * `directory`. The first differing unit in name order is named. For a unit
 * both hold, the tree is read once more to name the entries whose status
 * changed after `before` was taken: a created or rewritten file, a new link,
 * or the directory an entry was removed from. A file is named before the
 * directory that holds it. An entry that changed in the same clock tick as
 * the first measurement is not named, and the unit still is. The host also
 * changes a file's status when a hard link to it is made anywhere, so in a
 * unit that differs, a file whose bytes did not change can be named beside
 * the one that was written.
 *
 * @category measuring
 * @since 1.0.0
 */
export const difference = (
  directory: string,
  before: Identity,
  after: Identity,
  io: Io = defaultIo,
  limits: Limits = defaultLimits
): Change | undefined => {
  if (before.digest === after.digest) return undefined
  const names = [...new Set([...before.byUnit.keys(), ...after.byUnit.keys()])].sort()
  const differing = names.filter((name) => before.byUnit.get(name)?.digest !== after.byUnit.get(name)?.digest)
  const unit = differing[0]!
  const earlier = before.byUnit.get(unit)
  const rest = { morePaths: 0, moreUnits: differing.length - 1 }
  if (earlier === undefined) return { unit, kind: "added", paths: [], ...rest }
  if (!after.byUnit.has(unit)) return { unit, kind: "removed", paths: [], ...rest }
  const root = NodePath.join(directory, ...unit.split("/"))
  const newer = list(io, root, limits, { remaining: limits.entries })
    .filter((entry) => entry.stats.ctimeNs > earlier.latest)
  // A file or link says more than the directory whose listing it changed.
  const leaves = newer.filter((entry) => entry.kind !== "directory")
  const named = (leaves.length > 0 ? leaves : newer).map((entry) => entry.path === "" ? "." : entry.path)
  return {
    unit,
    kind: "written",
    paths: named.slice(0, maximumChangedPaths),
    morePaths: Math.max(0, named.length - maximumChangedPaths),
    moreUnits: rest.moreUnits
  }
}

/**
 * One line naming a {@link Change} of the tree at the workspace-relative
 * `tree`: the tree, the unit, and the paths written in it.
 *
 * @category formatting
 * @since 1.0.0
 */
export const describeChange = (tree: string, change: Change): string => {
  const others = change.moreUnits === 0
    ? ""
    : `; ${change.moreUnits} more ${change.moreUnits === 1 ? "unit" : "units"} changed`
  const unit = `${tree} unit ${change.unit}`
  if (change.kind !== "written") return `${unit} was ${change.kind}${others}`
  if (change.paths.length === 0) return `${unit} changed${others}`
  const more = change.morePaths === 0 ? "" : ` and ${change.morePaths} more`
  const verb = change.paths.length + change.morePaths === 1 ? "was" : "were"
  return `${unit}: ${change.paths.join(", ")}${more} ${verb} written${others}`
}
