/**
 * Shared bounded directory enumeration and descriptor cleanup.
 *
 * @since 1.0.0
 */

import type { Dirent } from "node:fs"

/**
 * The operations used on an already opened directory.
 * @category models
 * @since 1.0.0
 */
export interface Directory {
  readonly read: () => Promise<Dirent | null>
  readonly close: () => Promise<void>
}

/**
 * Reads at most one entry past the limit and always closes the directory.
 *
 * A caller may supply an overflow message to reject the extra entry instead
 * of returning it as a sentinel. A read or overflow failure takes precedence
 * over a subsequent close failure.
 *
 * @category execution
 * @since 1.0.0
 */
export const readDirectory = async (
  directory: Directory,
  limit: number,
  overflowMessage?: string
): Promise<Array<Dirent>> => {
  const entries: Array<Dirent> = []
  let primary: unknown
  try {
    while (overflowMessage !== undefined || entries.length <= limit) {
      const entry = await directory.read()
      if (entry === null) break
      if (entries.length >= limit && overflowMessage !== undefined) throw new Error(overflowMessage)
      entries.push(entry)
    }
  } catch (cause) {
    primary = cause
  }
  try {
    await directory.close()
  } catch (cause) {
    if (primary === undefined) primary = cause
  }
  if (primary !== undefined) throw primary
  return entries
}
