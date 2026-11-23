/**
 * Descriptor-relative reads of a replay directory and its entries.
 * @since 0.1.0
 */

import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"

interface Identity {
  readonly dev: bigint
  readonly ino: bigint
}

const verifyIdentity = (opened: Identity, named: Identity): void => {
  if (opened.dev !== named.dev || opened.ino !== named.ino) throw new Error("path changed during open")
}

/**
 * Pin a file or directory until its consumer has finished. Linux resolves child names through the open descriptor.
 * Other systems use the verified directory name and check each opened child.
 *
 * @throws {Error} When the path cannot be opened or its type is unsuitable.
 * @category store
 * @since 0.1.0
 */
export const openPinnedPath = async (
  source: string,
  directory: boolean,
  platform = process.platform,
  expected?: Identity
) => {
  const named = expected ?? await lstat(source, { bigint: true })
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const file = await open(source, directory ? flags | constants.O_DIRECTORY : flags)
  try {
    const info = await file.stat({ bigint: true })
    verifyIdentity(info, named)
    if (!directory && (!info.isFile() || info.nlink !== 1n)) throw new Error("unexpected file type or link count")
    let path = `/proc/self/fd/${file.fd}`
    if (platform !== "linux") {
      path = await realpath(source)
      const resolved = await lstat(path, { bigint: true })
      verifyIdentity(info, resolved)
      // Regular files can still be read by descriptor on Darwin.
      if (!directory) path = `/dev/fd/${file.fd}`
    }
    return { path, close: () => file.close() }
  } catch (error) {
    await file.close()
    throw error
  }
}
