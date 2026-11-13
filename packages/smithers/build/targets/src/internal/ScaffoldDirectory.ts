/**
 * Package-private scaffold directory operations.
 * @since 1.0.0
 */

import type * as NodeFs from "node:fs"
import type * as Fs from "node:fs/promises"

/**
 * Filesystem boundary used for deterministic publication fault tests.
 * @since 1.0.0
 * @private
 */
export type DirectoryIo = Pick<typeof Fs, "lstat" | "mkdir" | "realpath" | "readdir"> & {
  readonly join: (...paths: Array<string>) => string
  readonly inside: (root: string, candidate: string) => boolean
  readonly syncDirectory: (path: string) => Promise<void>
  readonly errorCode: (cause: unknown) => string | undefined
}

/**
 * Creates a workspace directory one component at a time without following links.
 * @since 1.0.0
 * @private
 */
export const ensureDirectory = async (root: string, relative: string, io: DirectoryIo): Promise<string> => {
  let current = root
  for (const segment of relative === "." ? [] : relative.split("/")) {
    const parent = current
    const candidate = io.join(parent, segment)
    let stats: NodeFs.Stats
    let created = false
    try {
      stats = await io.lstat(candidate)
    } catch (cause) {
      if (io.errorCode(cause) !== "ENOENT") throw cause
      try {
        await io.mkdir(candidate)
        created = true
      } catch (mkdirCause) {
        if (io.errorCode(mkdirCause) !== "EEXIST") throw mkdirCause
      }
      if (created) await io.syncDirectory(parent)
      stats = await io.lstat(candidate)
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`package scaffold parent is not a real directory: ${candidate}`)
    }
    const canonical = await io.realpath(candidate)
    if (!io.inside(root, canonical)) {
      throw new Error(`package scaffold parent leaves the workspace: ${candidate}`)
    }
    current = canonical
  }
  return current
}

/**
 * How old a scaffold temporary directory must be before a later run reclaims it.
 * A younger one may belong to a concurrent scaffold that is still writing.
 */
const staleTemporaryMs = 5 * 60 * 1000

/**
 * Removes scaffold temporary directories a killed process left under `parent`.
 * In-process failures clean up after themselves; SIGKILL, OOM, and power loss
 * do not, and a leftover holds a `package.json` under the packages glob.
 * @since 1.0.0
 * @private
 */
export const reclaimStaleTemporaries = async (
  parent: string,
  remove: (path: string) => Promise<void>,
  io: DirectoryIo
): Promise<void> => {
  const cutoff = Date.now() - staleTemporaryMs
  for (const entry of await io.readdir(parent)) {
    if (!/^\.smthrs-scaffold-.*\.tmp$/.test(entry)) continue
    const path = io.join(parent, entry)
    // Best effort: a leftover that vanished or cannot be read is not ours to fail on.
    // lstat reports a symbolic link as a non-directory, so links are never followed.
    const stats = await io.lstat(path).catch(() => undefined)
    if (stats?.isDirectory() === true && stats.mtimeMs < cutoff) await remove(path)
  }
}
