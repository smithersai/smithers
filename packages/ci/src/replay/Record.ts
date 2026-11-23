/**
 * File boundary between a workload and the replay that reads its results.
 * @since 0.1.0
 */

import { Buffer } from "node:buffer"
import { constants } from "node:fs"
import { open } from "node:fs/promises"

/**
 * Read a worker's record through a pinned regular file, with a fixed allocation.
 * A growing, truncated or oversized record is incomplete.
 *
 * @category reading
 * @throws {Error} When the record cannot be opened or read.
 * @since 0.1.0
 */
export const recordText = async (path: string, limit = 32 * 1024 * 1024): Promise<string | undefined> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) return undefined
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    return offset === info.size ? bytes.toString("utf8", 0, offset) : undefined
  } finally {
    await file.close()
  }
}
