/**
 * The Go compile cache the build system owns.
 *
 * `go` keeps compiled packages and test results in `GOCACHE`. Left to the
 * host, that directory sits outside the workspace, grows without a bound the
 * build system can see, and is shared with every other `go` on the machine.
 * Every tool a target spawns, and every `go` the planner probes with,
 * therefore runs with `GOCACHE` pointing inside the workspace's cache
 * directory, where `cache status` measures it.
 *
 * @since 0.1.0
 */

import * as Config from "@smthrs/targets/Config"
import * as Data from "effect/Data"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/**
 * One refusal to measure or change the compile cache.
 *
 * @category errors
 * @since 0.1.0
 */
export class GoCacheError extends Data.TaggedError("smithers-build/GoCacheError")<{
  /** `not-a-directory` when the cache path is a file or a link. */
  readonly reason: "not-a-directory"
  readonly message: string
}> {
  constructor(reason: "not-a-directory", message: string) {
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
 * The absolute compile cache directory of the workspace at `root`.
 *
 * @category querying
 * @since 0.1.0
 */
export const directory = (root: string, cacheDirectory: string): string =>
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
  cacheDirectory: string
): Record<string, string> => ({ GOCACHE: directory(root, cacheDirectory), ...env })

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
 * following a link, so nothing outside the workspace is ever measured.
 */
const existing = async (root: string, cacheDirectory: string): Promise<string | undefined> => {
  let current = await Fs.realpath(root)
  for (const part of [...Config.normalizeCacheDirectory(cacheDirectory).split("/"), directoryName]) {
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
export const entries = async (root: string, cacheDirectory: string): Promise<ReadonlyArray<Entry>> => {
  const base = await existing(root, cacheDirectory)
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
export const status = async (root: string, cacheDirectory: string): Promise<{
  readonly directory: string
  readonly exists: boolean
  readonly entries: number
  readonly bytes: number
}> => {
  const listed = await entries(root, cacheDirectory)
  return {
    directory: directory(root, cacheDirectory),
    exists: await existing(root, cacheDirectory) !== undefined,
    entries: listed.length,
    bytes: listed.reduce((sum, entry) => sum + entry.bytes, 0)
  }
}
