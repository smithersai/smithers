/**
 * Host access for the sandbox example: the POSIX owner check on the scratch
 * root, creating that root, and the link walk that confines a path to it.
 *
 * @since 0.1.0
 */
import { Effect } from "effect"
import type * as Path from "effect/Path"
import { lstatSync, mkdirSync, statSync } from "node:fs"

/**
 * Creates the scratch root, private to this user.
 *
 * @since 0.1.0
 */
export const ensureScratchRoot = (root: string): Effect.Effect<void> =>
  Effect.sync(() => {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  })

/**
 * Whether POSIX ownership or mode refuses this root: another user owns it or it
 * grants any group or other permission. The check is POSIX only; Windows has no
 * getuid and libuv reports every writable directory as 0o777.
 *
 * @since 0.1.0
 */
export const scratchRootRefused = (canonicalRoot: string): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const uid = process.getuid?.()
    if (uid === undefined) return false
    const rootInfo = statSync(canonicalRoot)
    return rootInfo.uid !== uid || (rootInfo.mode & 0o077) !== 0
  })

/**
 * Resolves `requested` inside `canonicalRoot`.
 *
 * Inspects every component, including dangling links and parents of files that
 * do not exist yet. Refusing all symlinks also prevents write's atomic
 * replacement helper from following a link outside the root.
 *
 * @since 0.1.0
 * @throws {Error} when the path is absolute, traverses out of the root, or crosses a link
 */
export const confinedPath = (path: Path.Path, canonicalRoot: string, requested: string): string => {
  if (path.isAbsolute(requested) || requested.split(/[/\\]/).includes("..") || requested.includes("\0")) {
    throw new Error("Paths must be relative to the scratch root without traversal")
  }
  const destination = path.resolve(canonicalRoot, requested)
  const relative = path.relative(canonicalRoot, destination)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path leaves the scratch root")
  }
  let current = canonicalRoot
  for (const part of ["", ...relative.split(path.sep)]) {
    current = path.join(current, part)
    const info = lstatSync(current, { throwIfNoEntry: false })
    if (info?.isSymbolicLink() || (info?.isFile() && info.nlink > 1)) {
      throw new Error("Linked files are not available in the scratch filesystem")
    }
  }
  return destination
}
