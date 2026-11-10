/**
 * The platform code of FactoryProjectionExec.vibe, which a .vibe file does not
 * import as a value (EK4402).
 *
 * @since 1.0.0
 */

import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/**
 * The last segment of a host path.
 *
 * @category paths
 * @since 1.0.0
 */
export const basename = (path: string): string => NodePath.basename(path)

/**
 * Joins host path segments.
 *
 * @category paths
 * @since 1.0.0
 */
export const join = (...segments: ReadonlyArray<string>): string => NodePath.join(...segments)

/**
 * The host relative path from one path to another.
 *
 * @category paths
 * @since 1.0.0
 */
export const relative = (from: string, to: string): string => NodePath.relative(from, to)

/**
 * Whether a workspace-relative path names a regular file under the canonical
 * workspace root; any failure to stat it reads as absent.
 *
 * @category files
 * @since 1.0.0
 */
export const isRegularFile = async (workspaceRoot: string, path: string): Promise<boolean> => {
  const root = await SafeFs.canonicalRoot(workspaceRoot)
  try {
    return (await Fs.lstat(NodePath.join(root, ...path.split("/")))).isFile()
  } catch {
    return false
  }
}

/**
 * Removes a workspace-relative file under the canonical workspace root, if it
 * exists.
 *
 * @category files
 * @since 1.0.0
 */
export const removeFile = async (workspaceRoot: string, path: string): Promise<void> => {
  const root = await SafeFs.canonicalRoot(workspaceRoot)
  await Fs.rm(NodePath.join(root, ...path.split("/")), { force: true })
}
