/**
 * Descriptor-relative reads of a replay directory and its entries.
 * @since 0.1.0
 */

import { constants } from "node:fs"
import { open } from "node:fs/promises"

/**
 * Pin a file or directory until its consumer has finished. Child paths resolve
 * through the directory descriptor, even if the original name moves.
 *
 * @throws {Error} When the path cannot be opened or its type is unsuitable.
 * @category store
 * @since 0.1.0
 */
export const openPinnedPath = async (source: string, directory: boolean) => {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const file = await open(source, directory ? flags | constants.O_DIRECTORY : flags)
  try {
    if (!directory) {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1) throw new Error("unexpected file type or link count")
    }
    const path = `/dev/fd/${file.fd}`
    return { path, close: () => file.close() }
  } catch (error) {
    await file.close()
    throw error
  }
}
