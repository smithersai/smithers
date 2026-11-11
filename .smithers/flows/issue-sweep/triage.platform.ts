// The platform code of triage.vibe: hashing and the one-file answer cache on Node's filesystem.
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * The hex SHA-256 of `text`.
 * @throws {never}
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** The cache file's text, or `undefined` when it cannot be read. */
export const readCache = (path: string): Promise<string | undefined> => readFile(path, "utf8").then((text) => text, () => undefined)

/** Replaces the cache file whole through a temporary name, creating its directory. */
export const writeCache = async (path: string, text: string): Promise<void> => {
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, text)
  await rename(temporary, path)
}
