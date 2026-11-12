/**
 * The canonical location of one Alchemy state directory.
 *
 * Every writer of Alchemy state resolves the directory here before it reads or
 * changes anything: the deploy wrapper before it takes ownership, the
 * remote-state pull before it replaces files, and redaction before it walks
 * the tree. A state directory reached through a symbolic link, in the root or
 * in an ancestor, would otherwise make the link's target disposable state,
 * whose JSON files the pull deletes and replaces before a later check refuses
 * the link.
 *
 * @since 0.1.0
 */

import { errorCode } from "@smthrs/targets/SafeFs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/**
 * Resolves an Alchemy state directory to its canonical root.
 *
 * The directory must be absolute, and every existing component of it must be
 * a real directory, never a symbolic link. A directory that does not exist yet
 * resolves to `null` once its existing ancestors pass the same check, which is
 * how a stack that has never been deployed starts.
 *
 * @returns The canonical root, which is the directory itself, or `null` when
 * the directory does not exist.
 * @throws {TypeError} For a relative directory, a symbolic link in the root or
 * an ancestor, or a root that is not a directory. Other filesystem failures
 * also reject.
 * @category utilities
 * @since 0.1.0
 */
export const resolveStateRoot = async (directory: string): Promise<string | null> => {
  if (!NodePath.isAbsolute(directory)) throw new TypeError(`Alchemy state directory must be absolute: ${directory}`)
  const requestedRoot = NodePath.resolve(directory)
  let root: string
  try {
    root = await Fs.realpath(requestedRoot)
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      // Windows also reports ENOENT for file/child. Validate the existing
      // ancestors before treating this as a deployment with no state.
      const parent = NodePath.dirname(requestedRoot)
      if (parent === requestedRoot) throw error
      await resolveStateRoot(parent)
      return null
    }
    throw error
  }
  if (root !== requestedRoot) {
    throw new TypeError(`symbolic links are not allowed in the Alchemy state root: ${directory}`)
  }
  if (!(await Fs.lstat(root)).isDirectory()) throw new TypeError(`Alchemy state root is not a directory: ${root}`)
  return root
}
