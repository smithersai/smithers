// The platform code of disk.vibe: Node's filesystem, home and temporary directories, which a .vibe file does not import.
import { existsSync, statfsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/** The free bytes of the volume holding `~/.microsandbox` (or the home directory when it does not exist). */
export const statfsFree = () => {
  const home = join(homedir(), ".microsandbox")
  const stats = statfsSync(existsSync(home) ? home : homedir())
  return stats.bavail * stats.bsize
}

/**
 * The Go build cache the sweep's own builds use, under the system temporary directory.
 * @throws {never}
 */
export function issueSweepGoCache(): string {
  return join(tmpdir(), "issue-sweep-go-build")
}
