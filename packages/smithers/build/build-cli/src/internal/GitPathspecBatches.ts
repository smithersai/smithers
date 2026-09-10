/**
 * Bounds selected Git paths without relying on stdin flags unsupported by diff.
 *
 * @since 1.0.0
 */

/**
 * Preserves path order in batches with room for the executable, fixed options,
 * and environment below platform argv limits. Count UTF-8 bytes, terminators,
 * and argv pointers. Literal pathspecs prevent a selected filename from matching
 * another batch's files through Git's pathspec syntax.
 *
 * @category internal
 * @since 1.0.0
 */
export const gitPathspecBatches = (paths: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
  const batches: Array<Array<string>> = []
  let batch: Array<string> = []
  let bytes = 0
  for (const path of paths) {
    const pathspec = `:(literal)${path}`
    const size = Buffer.byteLength(pathspec, "utf8") + 1 + 8
    if (batch.length > 0 && bytes + size > 32 * 1024) {
      batches.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(pathspec)
    bytes += size
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}
