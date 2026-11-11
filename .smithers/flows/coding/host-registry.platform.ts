// The platform code of host-registry.vibe: Node's filesystem and path APIs, which a .vibe file does not import.
import { lstat, mkdir, rename } from "node:fs/promises"
import { join, resolve } from "node:path"

/**
 * The durable execution archive under the host's state root.
 * @throws {never}
 */
export function archiveRoot(stateRoot: string): string {
  return join(stateRoot, "registry")
}

/**
 * Moves the legacy `.flows` archive directories under the state root. Only the
 * archive directories move. Existing control journals, their codecs and their
 * database locations are unchanged. Each rename is atomic, so a restart after
 * moving one directory finishes the other rather than losing it.
 */
export async function relocateLegacyArchive(sourceRoot: string, stateRoot: string): Promise<void> {
  const root = archiveRoot(stateRoot)
  if (resolve(sourceRoot) === resolve(root)) throw new Error("Execution archive must be outside source")
  const legacy = join(sourceRoot, ".flows")
  const info = await lstat(legacy).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (info === undefined) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Legacy execution archive is not a directory")
  for (const kind of ["objects", "executions"]) {
    const from = join(legacy, kind), to = join(root, ".flows", kind)
    const old = await lstat(from).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (old === undefined) continue
    if (!old.isDirectory() || old.isSymbolicLink()) throw new Error("Legacy execution archive is not a directory")
    // Never replace another retained archive. A conflicting destination is
    // visible rather than silently discarding either attempt's evidence.
    const present = await lstat(to).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (present !== undefined) throw new Error("Execution archive migration conflicts with retained state")
    await mkdir(join(root, ".flows"), { recursive: true, mode: 0o700 })
    await rename(from, to)
  }
}
