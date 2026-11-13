/** Safe, local action-cache inspection and retention operations.
 * @since 0.1.0
 */

import * as Config from "@smthrs/targets/Config"
import * as Data from "effect/Data"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { type CachedResult, entryLimit, sanitizeKey } from "./Cache.ts"
import * as GoCache from "./internal/GoCache.ts"
import { byCodeUnit } from "./internal/Text.ts"

/** Metadata for an individually removable local action-result file.
 * @category models
 * @since 0.1.0
 */
export interface Entry {
  readonly path: string
  readonly bytes: number
  readonly modifiedAt: string
  readonly inode: number
}

/** Resolves an existing cache directory without creating it or following links.
 * @category querying
 * @since 0.1.0
 */
export const directory = async (root: string, cacheDirectory: string): Promise<string | undefined> => {
  let current = await Fs.realpath(root)
  for (const part of [...Config.normalizeCacheDirectory(cacheDirectory).split("/"), "cache"]) {
    current = Path.join(current, part)
    const stat = await Fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (stat === undefined) return undefined
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`cache path is not a plain directory: ${current}`)
  }
  return current
}

/** Lists only regular files in the local result cache's shard layout.
 * @category querying
 * @since 0.1.0
 */
export const entries = async (root: string, cacheDirectory: string): Promise<ReadonlyArray<Entry>> => {
  const base = await directory(root, cacheDirectory)
  if (base === undefined) return []
  const result: Array<Entry> = []
  for (const shard of await Fs.readdir(base, { withFileTypes: true })) {
    if (!shard.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]?$/.test(shard.name)) continue
    const shardPath = Path.join(base, shard.name)
    if ((await Fs.lstat(shardPath)).isSymbolicLink()) continue
    for (const name of await Fs.readdir(shardPath)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/.test(name) || !name.startsWith(shard.name)) continue
      const path = Path.join(shardPath, name)
      const stat = await Fs.lstat(path).catch(() => undefined)
      if (stat?.isFile() && !stat.isSymbolicLink()) {
        result.push({ path, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), inode: stat.ino })
      }
    }
  }
  return result.sort((a, b) => byCodeUnit(a.path, b.path))
}

/** Reads only metadata from the requested local result, without hydrating or creating state.
 * @category querying
 * @since 0.1.0
 */
export const inspect = async (
  root: string,
  cacheDirectory: string,
  key: string
): Promise<Pick<CachedResult, "key" | "target" | "label" | "exitOk" | "storedAt"> | undefined> => {
  const safe = sanitizeKey(key)
  const base = await directory(root, cacheDirectory)
  if (base === undefined) return undefined
  const shard = Path.join(base, safe.slice(0, 2))
  const shardStat = await Fs.lstat(shard).catch(() => undefined)
  if (!shardStat?.isDirectory() || shardStat.isSymbolicLink()) return undefined
  const path = Path.join(shard, `${safe}.json`)
  const stat = await Fs.lstat(path).catch(() => undefined)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > entryLimit) return undefined
  const data: unknown = await Fs.readFile(path, "utf8").then(JSON.parse).catch(() => undefined)
  if (typeof data !== "object" || data === null) return undefined
  const entry = data as Partial<CachedResult>
  if (
    entry.key !== key || typeof entry.label !== "string" || typeof entry.target !== "string" ||
    typeof entry.exitOk !== "boolean" || typeof entry.storedAt !== "string"
  ) return undefined
  return { key, label: entry.label, target: entry.target, exitOk: entry.exitOk, storedAt: entry.storedAt }
}

const sizeUnits: Readonly<Record<string, number>> = {
  "": 1,
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4
}

/** A cache size the CLI could not read.
 * @category errors
 * @since 0.1.0
 */
export class CacheSizeError extends Data.TaggedError("smithers-build/CacheSizeError")<{
  readonly text: string
  readonly message: string
}> {
  constructor(text: string) {
    super({ text, message: `cache size must be a number with an optional unit such as 40GiB or 500MB: ${text}` })
  }
}

/** Reads a size such as `40GiB`, `500MB` or `1024` (bytes) as a byte count.
 * @category querying
 * @since 0.1.0
 */
export const parseSize = (text: string): number => {
  const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/.exec(text.trim())
  const unit = match === null ? undefined : sizeUnits[match[2]!.toLowerCase()]
  if (match === null || unit === undefined) throw new CacheSizeError(text)
  return Math.floor(Number(match[1]) * unit)
}

/** Removes individual action result files and, under a size cap, Go compile cache entries that are not in use;
 * never removes a directory or other run state.
 *
 * `maxSizeBytes` caps the action results plus the Go compile cache. The least recently used entries go first, and a
 * compile cache entry a running tool may be reading is never a candidate.
 * @category execution
 * @since 0.1.0
 */
export const remove = async (options: {
  readonly root: string
  readonly cacheDirectory: string
  readonly olderThanDays?: number | undefined
  readonly maxSizeBytes?: number | undefined
  readonly dryRun: boolean
  readonly yes: boolean
  readonly now?: number | undefined
  /** What Go compile cache leases are judged against; the running process's own clock and host when omitted. */
  readonly leaseHost?: GoCache.LeaseHost | undefined
  /**
   * Keep compile cache entries used this recently even when no lease covers them; one hour when omitted, and never
   * less. Raise it when a `go` this build system did not start uses the same directory for longer than that.
   */
  readonly keepUsedWithinMs?: number | undefined
  /** The host environment, whose `SMITHERS_GO_CACHE` names a compile cache shared between workspaces. */
  readonly environment?: GoCache.Environment | undefined
}) => {
  if (!options.dryRun && !options.yes) {
    throw new Error("cache deletion requires --yes; use --dry-run to inspect candidates")
  }
  const now = options.now ?? Date.now()
  const cutoff = options.olderThanDays === undefined ? Infinity : now - options.olderThanDays * 86_400_000
  const results = await entries(options.root, options.cacheDirectory)
  const candidates = results.filter((entry) => Date.parse(entry.modifiedAt) < cutoff)
  // A statement, not an awaited conditional operand: V8 credits the code after
  // an `await` in one operand to that operand alone, through the size-cap block.
  let compiled: ReadonlyArray<GoCache.Entry> = []
  if (options.maxSizeBytes !== undefined) {
    compiled = await GoCache.entries(options.root, options.cacheDirectory, options.environment)
  }
  const goBuild = { candidates: 0, candidateBytes: 0, removed: 0, bytes: 0, inUse: 0, inUseBytes: 0 }
  const evicted: Array<GoCache.Entry> = []
  const before = [...results, ...compiled].reduce((sum, entry) => sum + entry.bytes, 0)
  let projected = before - candidates.reduce((sum, entry) => sum + entry.bytes, 0)
  if (options.maxSizeBytes !== undefined) {
    const usage = await GoCache.usage(
      options.root,
      options.cacheDirectory,
      options.leaseHost ?? GoCache.leaseHost(now),
      options.environment,
      options.keepUsedWithinMs
    )
    if (!options.dryRun) { for (const lease of usage.stale) await GoCache.releaseLease(lease) }
    const aged = new Set(candidates)
    const pool = [
      ...results.filter((entry) => !aged.has(entry)).map((entry) => ({
        usedAt: Date.parse(entry.modifiedAt),
        result: entry
      })),
      ...compiled.map((entry) => ({ usedAt: entry.usedAt, compiled: entry }))
    ].sort((a, b) => a.usedAt - b.usedAt)
    for (const item of pool) {
      if (projected <= options.maxSizeBytes) break
      if ("result" in item) {
        candidates.push(item.result)
        projected -= item.result.bytes
      } else if (item.usedAt > usage.floor) {
        goBuild.inUse += 1
        goBuild.inUseBytes += item.compiled.bytes
      } else {
        evicted.push(item.compiled)
        goBuild.candidates += 1
        goBuild.candidateBytes += item.compiled.bytes
        projected -= item.compiled.bytes
      }
    }
  }
  let removed = 0
  let bytes = 0
  for (const entry of candidates) {
    if (options.dryRun) continue
    const base = await directory(options.root, options.cacheDirectory)
    if (base === undefined || Path.dirname(Path.dirname(entry.path)) !== base) {
      throw new Error("cache path changed during deletion")
    }
    const shard = await Fs.lstat(Path.dirname(entry.path))
    if (!shard.isDirectory() || shard.isSymbolicLink()) throw new Error("cache shard changed during deletion")
    const current = await Fs.lstat(entry.path).catch(() => undefined)
    if (
      !current?.isFile() || current.isSymbolicLink() || current.ino !== entry.inode ||
      current.mtime.toISOString() !== entry.modifiedAt
    ) continue
    await Fs.unlink(entry.path)
    removed += 1
    bytes += entry.bytes
  }
  if (!options.dryRun) {
    Object.assign(goBuild, await GoCache.evict(options.root, options.cacheDirectory, evicted, options.environment))
  }
  return {
    scope: "local-action-results",
    dryRun: options.dryRun,
    candidates: candidates.length,
    candidateBytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0),
    removed,
    bytes,
    recoverable: false,
    ...(options.maxSizeBytes === undefined ? {} : {
      goBuild,
      size: {
        limit: options.maxSizeBytes,
        before,
        after: options.dryRun ? projected : before - bytes - goBuild.bytes
      }
    })
  }
}
