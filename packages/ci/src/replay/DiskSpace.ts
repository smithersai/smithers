/**
 * What the file system under a directory has free, and how much a directory
 * holds on it: the two numbers a replay keeps the disk from filling by.
 *
 * @since 0.1.0
 */

import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"
import { openPinnedPath } from "./PinnedFile.ts"

/**
 * One gigabyte, as a disk's size is written.
 *
 * @category constants
 * @since 0.1.0
 */
export const gigabyte = 1_000_000_000

/**
 * `bytes` as a person reads a size: `47 GB`, `3.2 GB`, `0.4 GB`.
 *
 * @category rendering
 * @since 0.1.0
 */
export const sizeOf = (bytes: number): string => {
  const gb = Math.max(0, bytes) / gigabyte
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`
}

/**
 * The bytes the file system that holds a path has free for a program of this
 * user, and its size.
 *
 * @category models
 * @since 0.1.0
 */
export interface Space {
  readonly free: number
  readonly total: number
}

/**
 * The free bytes and the size of the file system that holds `path`.
 *
 * @category reading
 * @since 0.1.0
 */
export const spaceOf = async (path: string): Promise<Space> => {
  const found = await NodeFs.statfs(path)
  return { free: found.bavail * found.bsize, total: found.blocks * found.bsize }
}

/**
 * The bytes on disk of every file under `path`, each file once however many
 * names it has, links not followed. A file or directory that goes while it is
 * read counts nothing.
 *
 * @category reading
 * @since 0.1.0
 */
export const heldUnder = async (path: string, signal?: AbortSignal): Promise<number> => {
  const seen = new Set<string>()
  let held = 0
  const visit = async (at: string): Promise<void> => {
    try {
      const info = await NodeFs.lstat(at, { bigint: true })
      const identity = `${info.dev}:${info.ino}`
      if (seen.has(identity)) return
      seen.add(identity)
      if (info.isDirectory()) {
        const directory = await openPinnedPath(at, true)
        try {
          const names = await NodeFs.readdir(directory.path)
          for (const name of names) {
            if (signal?.aborted) break
            await visit(NodePath.join(directory.path, name))
          }
        } finally {
          await directory.close()
        }
        return
      }
      held += Number(info.blocks) * 512
    } catch {
      // A directory may disappear or become unreadable while its job is running.
    }
  }
  await visit(path)
  return held
}
