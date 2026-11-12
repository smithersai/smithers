/**
 * The repository root and the entry-point guard, importing nothing outside Node.
 *
 * A release job that checks out the repository and installs no dependencies
 * (the installer archive and signing jobs of `release.yml`) still runs release
 * scripts. Those scripts read this module, never `workspace-packages.mjs`,
 * whose membership reader needs the installed `yaml` and `tinyglobby`.
 * `workspace-packages.mjs` exports the same two names for every script that
 * runs after the install; fixtures copy that one file into scratch roots, so
 * it stays a single file.
 */
import { realpathSync } from "node:fs"
import { resolve } from "node:path"

/** The repository root, resolved from this file rather than `process.cwd()`. */
export const repoRoot = resolve(import.meta.dirname, "../../..")

/**
 * Whether the module that owns `meta` is the process entry point.
 *
 * Both sides are real paths, so a symlinked, relative, or space-containing
 * invocation still matches.
 */
export const isMain = (meta) => {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(meta.filename)
  } catch {
    return false
  }
}
