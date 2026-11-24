/**
 * Host program lookup for inventory queries outside the checkout.
 *
 * @since 0.1.0
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path"

/**
 * Machine configuration needed by read-only Homebrew and Rust queries.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const probeEnvironment = (): Record<string, string | undefined> => ({
  HOME: process.env["HOME"],
  USER: process.env["USER"],
  TMPDIR: process.env["TMPDIR"],
  RUSTUP_HOME: process.env["RUSTUP_HOME"],
  CARGO_HOME: process.env["CARGO_HOME"]
})

const canonical = (file: string): string | undefined => {
  try {
    return realpathSync.native(file)
  } catch {
    return undefined
  }
}

const outside = (root: string, file: string): boolean => {
  const part = relative(root, file)
  return part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)
}

/**
 * A checkout-independent search path for host executables.
 *
 * @category models
 * @since 0.1.0
 */
export interface HostPath {
  readonly path: string
  /** @throws {never} */
  program(name: string): string | undefined
}

/**
 * A search path containing only host directories. Check the final executable as well:
 * an otherwise trusted directory can contain a symlink into the checkout or a working copy.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const hostPath = (root: string, search: string, ...otherRoots: ReadonlyArray<string>): HostPath => {
  const roots = [...new Set([root, ...otherRoots])]
  const lexicalRoots = roots.map((directory) => resolve(directory))
  const realRoots = roots.map(canonical)
  const target = (file: string): string | undefined => {
    if (!isAbsolute(file) || lexicalRoots.some((directory) => !outside(directory, file))) return undefined
    const real = canonical(file)
    if (real === undefined) return undefined
    const trusted = realRoots.every((directory) =>
      directory !== undefined && outside(directory, file) && outside(directory, real)
    )
    return trusted ? real : undefined
  }
  const directories = new Set<string>()
  for (const entry of search.split(delimiter)) {
    const directory = target(entry)
    if (directory !== undefined && !directory.includes(delimiter)) directories.add(directory)
  }
  const program = (name: string): string | undefined => {
    for (const directory of directories) {
      const entry = join(directory, name)
      const file = target(entry)
      if (file === undefined) continue
      try {
        accessSync(file, constants.X_OK)
        // Homebrew computes its prefix from the path used to invoke its script.
        if (statSync(file).isFile()) return name === "brew" ? entry : file
      } catch {
        // Another directory may provide an executable under the same name.
      }
    }
    return undefined
  }
  return { path: [...directories].join(delimiter), program }
}
