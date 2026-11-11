import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Whether a `jj` binary is on `PATH`; the real-binary cases skip without one.
 *
 * @throws {never}
 */
export const jjInstalled = (): boolean => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/**
 * Creates a throwaway jj repository and returns its absolute root.
 *
 * @throws When the directory cannot be created or `jj git init` fails.
 */
export const makeRepository = (): string => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), "flows-jj-quickstart-")))
  execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
  return repository
}
