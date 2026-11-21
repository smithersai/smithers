/** The bytes of every file named `ballast` under a directory: what a test's step writes to take disk space. */
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"

export const ballastUnder = async (path: string): Promise<number> => {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined) return 0
  if (!info.isDirectory()) return info.isFile() && path.endsWith("/ballast") ? info.size : 0
  const names = await readdir(path).catch(() => [])
  let total = 0
  for (const name of names) total += await ballastUnder(join(path, name))
  return total
}
