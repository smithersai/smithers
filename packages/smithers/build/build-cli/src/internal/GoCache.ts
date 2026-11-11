/**
 * The Go compile cache the build system owns.
 *
 * `go` keeps compiled packages and test results in `GOCACHE`. Left to the
 * host, that directory sits outside the workspace, grows without a bound the
 * build system can see, and is shared with every other `go` on the machine.
 * Every tool a target spawns, and every `go` the planner probes with,
 * therefore runs with `GOCACHE` pointing inside the workspace's cache
 * directory, where `cache status` measures it. A host that builds many
 * checkouts of one repository names one directory for all of them in
 * `SMITHERS_GO_CACHE`, and the build system owns that directory instead.
 *
 * @since 0.1.0
 */

import * as Config from "@smthrs/targets/Config"
import * as Data from "effect/Data"
import { randomUUID } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"

/**
 * One refusal to measure or change the compile cache.
 *
 * @category errors
 * @since 0.1.0
 */
export class GoCacheError extends Data.TaggedError("smithers-build/GoCacheError")<{
  /**
   * `not-a-directory` when the cache path is a file or a link, `changed` when
   * the directory was replaced while entries were being removed, `location`
   * when `SMITHERS_GO_CACHE` does not name an absolute directory.
   */
  readonly reason: "not-a-directory" | "changed" | "location"
  readonly message: string
}> {
  constructor(reason: "not-a-directory" | "changed" | "location", message: string) {
    super({ reason, message })
  }
}

/**
 * The compile cache's directory name beneath the workspace cache directory.
 *
 * @category constants
 * @since 0.1.0
 */
export const directoryName = "go-build"

/**
 * The host environment variable that names one compile cache directory for
 * every workspace on the machine.
 *
 * @category constants
 * @since 0.1.0
 */
export const environmentName = "SMITHERS_GO_CACHE"

/**
 * The host environment a compile cache is located from.
 *
 * @category models
 * @since 0.1.0
 */
export type Environment = Readonly<Record<string, string | undefined>>

const shared = (environment: Environment): string | undefined => {
  const value = environment[environmentName]
  if (value === undefined || value === "") return undefined
  if (!NodePath.isAbsolute(value)) {
    throw new GoCacheError("location", `${environmentName} must be an absolute directory: ${value}`)
  }
  return NodePath.resolve(value)
}

/**
 * The absolute compile cache directory of the workspace at `root`: the one
 * `SMITHERS_GO_CACHE` names in `environment`, else `go-build` inside the
 * workspace cache directory.
 *
 * @category querying
 * @since 0.1.0
 */
export const directory = (root: string, cacheDirectory: string, environment: Environment = {}): string =>
  shared(environment) ??
    NodePath.join(root, ...Config.normalizeCacheDirectory(cacheDirectory).split("/"), directoryName)

/**
 * The environment one tool spawns with: the owned `GOCACHE`, unless the
 * target's declaration names its own.
 *
 * Every tool gets it, not only the `Go.*` rules, because a shell command or a
 * `S.Go.run` tool that starts `go` compiles into the same cache.
 *
 * The value is set at spawn and never planned. A compile cache changes how
 * long a build takes, not what it produces, so it is not key material; and an
 * absolute path in the planned environment would split the result cache per
 * checkout.
 *
 * @category execution
 * @since 0.1.0
 */
export const spawnEnvironment = (
  env: Readonly<Record<string, string>>,
  root: string,
  cacheDirectory: string,
  environment: Environment = {}
): Record<string, string> => ({ GOCACHE: directory(root, cacheDirectory, environment), ...env })

/**
 * One file `go` wrote into the compile cache.
 *
 * @category models
 * @since 0.1.0
 */
export interface Entry {
  readonly path: string
  readonly bytes: number
  /** When `go` last used the entry; `go` refreshes it at most once an hour. */
  readonly usedAt: number
  readonly inode: number
}

const shardName = /^[0-9a-f]{2}$/
const entryName = /^[0-9a-f]{64}-[ad]$/

/**
 * Resolves the existing compile cache directory without creating it or
 * following a link, so nothing but the owned directory is ever measured.
 */
const existing = async (
  root: string,
  cacheDirectory: string,
  environment: Environment
): Promise<string | undefined> => {
  const named = shared(environment)
  let current = named === undefined ? await Fs.realpath(root) : NodePath.dirname(named)
  const parts = named === undefined
    ? [...Config.normalizeCacheDirectory(cacheDirectory).split("/"), directoryName]
    : [NodePath.basename(named)]
  for (const part of parts) {
    current = NodePath.join(current, part)
    const stat = await Fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (stat === undefined) return undefined
    if (!stat.isDirectory()) {
      throw new GoCacheError("not-a-directory", `Go compile cache path is not a plain directory: ${current}`)
    }
  }
  return current
}

/**
 * Lists the action and output files in the compile cache's shard layout.
 *
 * Only `<two hex digits>/<64 hex digits>-a` and `-d` regular files count.
 * `go`'s own bookkeeping (`README`, `trim.txt`) and its fuzz corpus cache are
 * not compile results and are never listed.
 *
 * @category querying
 * @since 0.1.0
 */
export const entries = async (
  root: string,
  cacheDirectory: string,
  environment: Environment = {}
): Promise<ReadonlyArray<Entry>> => {
  const base = await existing(root, cacheDirectory, environment)
  if (base === undefined) return []
  const result: Array<Entry> = []
  for (const shard of await Fs.readdir(base, { withFileTypes: true })) {
    if (!shard.isDirectory() || !shardName.test(shard.name)) continue
    const shardPath = NodePath.join(base, shard.name)
    for (const name of await Fs.readdir(shardPath)) {
      if (!entryName.test(name) || !name.startsWith(shard.name)) continue
      const path = NodePath.join(shardPath, name)
      // A running `go` trims and replaces entries while this walk reads them.
      const stat = await Fs.lstat(path).catch(() => undefined)
      if (stat?.isFile()) result.push({ path, bytes: stat.size, usedAt: stat.mtimeMs, inode: stat.ino })
    }
  }
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/**
 * The compile cache's size as `cache status` reports it.
 *
 * @category querying
 * @since 0.1.0
 */
export const status = async (root: string, cacheDirectory: string, environment: Environment = {}): Promise<{
  readonly directory: string
  readonly exists: boolean
  readonly entries: number
  readonly bytes: number
}> => {
  const listed = await entries(root, cacheDirectory, environment)
  return {
    directory: directory(root, cacheDirectory, environment),
    exists: await existing(root, cacheDirectory, environment) !== undefined,
    entries: listed.length,
    bytes: listed.reduce((sum, entry) => sum + entry.bytes, 0)
  }
}

/**
 * How stale an entry's use time can be while the entry is still in use.
 *
 * `go` marks an entry used by setting its modification time, and skips the
 * write when the time is already less than an hour old. An entry a build
 * touched can therefore carry a time up to one hour before that build began.
 *
 * @category constants
 * @since 0.1.0
 */
export const useGranularityMs = 60 * 60 * 1000

/**
 * How long a lease can be believed. No tool run outlives it, so an older
 * lease is one its owner never released: a killed process whose id another
 * process now holds, or a file copied here with the workspace.
 *
 * @category constants
 * @since 0.1.0
 */
export const leaseLifetimeMs = 24 * 60 * 60 * 1000

/**
 * What a lease is judged against: the clock, this machine's name, and whether
 * a process is running. A caller that needs a different answer passes its own.
 *
 * @category models
 * @since 0.1.0
 */
export interface LeaseHost {
  readonly now: number
  readonly host: string
  readonly alive: (pid: number) => boolean
}

/**
 * The lease host of the running process.
 *
 * @category execution
 * @since 0.1.0
 */
export const leaseHost = (now: number = Date.now()): LeaseHost => ({
  now,
  host: Os.hostname(),
  alive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (cause) {
      // A process this user may not signal is still a running process.
      return (cause as NodeJS.ErrnoException).code === "EPERM"
    }
  }
})

const leaseDirectoryName = "smthrs-leases"

interface LeaseRecord {
  readonly pid: number
  readonly host: string
  readonly startedAt: number
}

/**
 * Records that a tool is about to use the compile cache, and returns the
 * lease to release when it exits.
 *
 * `cache prune --max-size` never evicts an entry a leased run could have
 * used. The lease lives inside the cache it protects, in a directory `go`
 * never reads or trims.
 *
 * @category execution
 * @since 0.1.0
 */
export const acquireLease = async (
  root: string,
  cacheDirectory: string,
  host: LeaseHost = leaseHost(),
  environment: Environment = {}
): Promise<string> => {
  const leases = NodePath.join(directory(root, cacheDirectory, environment), leaseDirectoryName)
  await Fs.mkdir(leases, { recursive: true })
  const record: LeaseRecord = { pid: process.pid, host: host.host, startedAt: host.now }
  const path = NodePath.join(leases, `${randomUUID()}.json`)
  await Fs.writeFile(path, JSON.stringify(record), { flag: "wx" })
  return path
}

/**
 * Releases a lease {@link acquireLease} returned. Releasing twice is harmless.
 *
 * @category execution
 * @since 0.1.0
 */
export const releaseLease = async (lease: string): Promise<void> => {
  await Fs.rm(lease, { force: true })
}

/**
 * Whether a tool that spawns with the owned cache takes a lease: a `Go.*` rule
 * always does, and any other tool does once the workspace has a compile cache
 * for a `go` it starts to read. A workspace that never ran `go` gains no
 * directory from this.
 *
 * @category execution
 * @since 0.1.0
 */
export const leased = async (
  rule: string,
  root: string,
  cacheDirectory: string,
  environment: Environment = {}
): Promise<boolean> =>
  rule.startsWith("Go.") ||
  await Fs.lstat(directory(root, cacheDirectory, environment)).then((stat) => stat.isDirectory(), () => false)

/**
 * What the leases say about the compile cache at one moment.
 *
 * @category models
 * @since 0.1.0
 */
export interface Usage {
  /**
   * Entries used after this time may be in use and are never evicted.
   *
   * It is one use-time granularity before the earliest live lease, and never
   * later than the idle time before now. The idle time covers what holds no
   * lease: a `go` the planner started, a `go` something other than this
   * build system started in the same directory, and every run that starts
   * after this moment. Such a run began later than `now`, so everything it
   * can touch is already above the floor or has its use time refreshed, which
   * {@link evict} checks again.
   */
  readonly floor: number
  /** Leases whose owner is gone. */
  readonly stale: ReadonlyArray<string>
}

/**
 * Reads the leases and answers which entries may be in use.
 *
 * @category querying
 * @since 0.1.0
 */
export const usage = async (
  root: string,
  cacheDirectory: string,
  host: LeaseHost = leaseHost(),
  environment: Environment = {},
  /**
   * How recently an entry must have been used to be kept when no lease
   * covers it. A `go` that holds no lease is safe only while it runs for less
   * than this minus one use-time granularity, so it is never taken below that
   * granularity.
   */
  idleMs: number = useGranularityMs
): Promise<Usage> => {
  const leases = NodePath.join(directory(root, cacheDirectory, environment), leaseDirectoryName)
  let earliest = Infinity
  const stale: Array<string> = []
  for (const name of (await Fs.readdir(leases).catch(() => [])).sort()) {
    const path = NodePath.join(leases, name)
    const text = await Fs.readFile(path, "utf8").catch(() => undefined)
    // Released between the listing and this read.
    if (text === undefined) continue
    const record = parseLease(text)
    if (
      record === undefined || host.now - record.startedAt >= leaseLifetimeMs ||
      (record.host === host.host && !host.alive(record.pid))
    ) stale.push(path)
    else earliest = Math.min(earliest, record.startedAt)
  }
  return { floor: Math.min(host.now - Math.max(idleMs, useGranularityMs), earliest - useGranularityMs), stale }
}

const parseLease = (text: string): LeaseRecord | undefined => {
  let record: Partial<LeaseRecord>
  try {
    record = JSON.parse(text) as Partial<LeaseRecord>
  } catch {
    return undefined
  }
  return typeof record?.pid === "number" && typeof record.host === "string" && typeof record.startedAt === "number"
    ? { pid: record.pid, host: record.host, startedAt: record.startedAt }
    : undefined
}

/**
 * Removes the given compile cache entries, skipping any that `go` has used
 * or replaced since it was listed.
 *
 * A run that starts while this works refreshes the use time of every old
 * entry it reads, so the check made at the moment of removal sees it. This is
 * the protocol `go`'s own trim relies on, with the margin taken from the runs
 * in flight instead of a fixed five days.
 *
 * @category execution
 * @since 0.1.0
 */
export const evict = async (
  root: string,
  cacheDirectory: string,
  candidates: ReadonlyArray<Entry>,
  environment: Environment = {}
): Promise<{ readonly removed: number; readonly bytes: number }> => {
  let removed = 0
  let bytes = 0
  for (const entry of candidates) {
    const base = await existing(root, cacheDirectory, environment)
    if (base === undefined || NodePath.dirname(NodePath.dirname(entry.path)) !== base) {
      throw new GoCacheError("changed", "Go compile cache path changed during eviction")
    }
    const current = await Fs.lstat(entry.path).catch(() => undefined)
    if (!current?.isFile() || current.ino !== entry.inode || current.mtimeMs !== entry.usedAt) continue
    await Fs.rm(entry.path, { force: true })
    removed += 1
    bytes += entry.bytes
  }
  return { removed, bytes }
}
