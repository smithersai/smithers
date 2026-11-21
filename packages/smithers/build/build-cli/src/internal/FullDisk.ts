/**
 * A full disk under a build's machines. A machine holds a checkout, a home and
 * a temporary directory, and a build keeps every machine it made until it
 * ends, so the machines of a large repository can fill the disk. A target
 * that fails then fails for want of space its own run may not have taken:
 * when the other machines hold more than its own, the failure is the build's,
 * and the line says so, with the disk and what the machines hold.
 *
 * @since 1.0.0
 */

import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"

/**
 * The free bytes, and the size, of the file system that holds a path.
 *
 * @category models
 * @since 1.0.0
 */
export interface Space {
  readonly free: number
  readonly total: number
}

/**
 * The file system that holds `path`, or `undefined` where the host does not
 * say.
 *
 * @category reading
 * @since 1.0.0
 */
export const spaceOf = async (path: string): Promise<Space | undefined> => {
  const found = await NodeFs.statfs(path).catch(() => undefined)
  return found === undefined ? undefined : { free: found.bavail * found.bsize, total: found.blocks * found.bsize }
}

/**
 * The bytes on disk of the files under `path`, each file once however many
 * names it has, links not followed. What cannot be read holds nothing.
 *
 * @category reading
 * @since 1.0.0
 */
export const heldUnder = async (path: string): Promise<number> => {
  const seen = new Set<string>()
  let held = 0
  const visit = async (at: string): Promise<void> => {
    const info = await NodeFs.lstat(at, { bigint: true }).catch(() => undefined)
    if (info === undefined) return
    if (info.isDirectory()) {
      for (const name of await NodeFs.readdir(at).catch(() => [])) await visit(NodePath.join(at, name))
      return
    }
    const identity = `${info.dev}:${info.ino}`
    if (seen.has(identity)) return
    seen.add(identity)
    held += Number(info.blocks) * 512
  }
  await visit(path)
  return held
}

/**
 * Whether a disk is full: less than 1 GB free, or less than 1% of it when
 * that is more. A write fails short of the last byte, and a tool that needs
 * room for a file of its own fails before that.
 *
 * @category checks
 * @since 1.0.0
 */
export const isFull = (space: Space): boolean => space.free < Math.max(1_000_000_000, space.total * 0.01)

/**
 * `bytes` as a person reads a size: `47 GB`, `3.2 GB`, `0.4 GB`.
 *
 * @category rendering
 * @since 1.0.0
 */
export const sizeOf = (bytes: number): string => {
  const gb = Math.max(0, bytes) / 1_000_000_000
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`
}

/**
 * What a machine target that failed on a full disk says, when the other
 * machines of its build hold more than its own.
 *
 * @category rendering
 * @since 1.0.0
 */
export const fullLine = (kept: string, space: Space, machines: number, all: number, own: number): string =>
  `the disk that holds this build's machines (${kept}) is full, ${sizeOf(space.free)} free: its ` +
  `${machines} machines hold ${sizeOf(all)}, this target's ${sizeOf(own)}, so the target did not fail on its own. ` +
  `Run fewer jobs at once (--jobs) or free some space`

/**
 * Why a machine target that failed failed, when it is the build's own: the
 * disk that holds `kept` is full and the other machines, `others`, hold more
 * than its own machine at `own`. `undefined` when the failure is the
 * target's.
 *
 * @category checks
 * @since 1.0.0
 */
export const buildsOwn = async (
  kept: string,
  own: string,
  others: ReadonlyArray<string>,
  space: (path: string) => Promise<Space | undefined> = spaceOf
): Promise<string | undefined> => {
  const found = await space(kept)
  if (found === undefined || !isFull(found)) return undefined
  const mine = await heldUnder(own)
  let theirs = 0
  for (const other of others) theirs += await heldUnder(other)
  return theirs > mine ? fullLine(kept, found, others.length + 1, mine + theirs, mine) : undefined
}
