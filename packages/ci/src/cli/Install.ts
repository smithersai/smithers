/**
 * Where this install keeps what a replay needs to run in a stranger's
 * checkout: the `smthrs` program, and a Node to run it on.
 *
 * @since 0.1.0
 */

import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { delimiter, dirname, isAbsolute, join, sep } from "node:path"

/**
 * Finds a module's file from this package, as `require.resolve` does.
 *
 * @category models
 * @since 0.1.0
 */
export type Resolve = (specifier: string) => string

const fromHere: Resolve = createRequire(import.meta.url).resolve

const directoryOf = (name: string, resolve: Resolve): string | undefined => {
  try {
    return dirname(resolve(`${name}/package.json`))
  } catch {
    return undefined
  }
}

/** A path's real location, or the path as given when it has none to resolve. */
const realOf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The top directory of the checkout that holds `directory`: the nearest
 * directory at or above it that holds a `.git`, or `directory` itself when
 * none does.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const checkoutOf = (directory: string): string => {
  let at = directory
  while (!existsSync(join(at, ".git"))) {
    const above = dirname(at)
    if (above === at) return directory
    at = above
  }
  return at
}

// True for a file this user may run that is not `self` and whose real location is not inside `checkout`. A file that
// cannot be run is no program: it would hide a Node later on the path. A file of a stranger's checkout is no Node of
// this machine's, whatever directory of the path names it or links to it.
const isProgram = (path: string, self: string, checkout: string | undefined): boolean => {
  try {
    accessSync(path, constants.X_OK)
    const real = realpathSync(path)
    const inside = checkout !== undefined && real.startsWith(realOf(checkout) + sep)
    return statSync(path).isFile() && real !== self && !inside
  } catch {
    return false
  }
}

/**
 * The Node that runs `smthrs`, which does not run on Bun. Under Node it is this
 * process. Under Bun it is the first `node` on the path that is not Bun itself:
 * `bunx` puts a `node` link to Bun on the path of a machine with no Node.
 *
 * An empty entry of the path means the working directory, which is a
 * stranger's checkout: it is skipped, so a `node` file of the repository is
 * never the program that runs `smthrs`. So is an entry that is not absolute.
 * So is a `node` whose real location is inside `checkout`, the stranger's
 * checkout the program runs in, when the path names a directory of it by its
 * whole name or a link leads into it.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const nodeProgram = (
  path: string | undefined,
  versions: Readonly<Record<string, string | undefined>> = process.versions,
  self: string = process.execPath,
  checkout: string | undefined = undefined
): string | undefined => {
  if (versions["bun"] === undefined) return self
  const bun = realpathSync(self)
  return (path ?? "")
    .split(delimiter)
    .filter((directory) => isAbsolute(directory))
    .map((directory) => join(directory, "node"))
    .find((node) => isProgram(node, bun, checkout))
}

/**
 * The command that starts this install's `smthrs`: the one `smithers-ci`
 * depends on, run by `node`, by default the program running now. Without it,
 * the `smthrs` on the path.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const smthrsCommand = (
  resolve: Resolve = fromHere,
  node: string = process.execPath
): readonly [string, ...Array<string>] => {
  const cli = directoryOf("@smthrs/cli", resolve)
  return cli === undefined ? ["smthrs"] : [node, join(cli, "bin", "smithers.mjs")]
}

/**
 * The command that starts this install's `smthrs` with the token of a shared
 * cache: `smthrs-with-token.mjs` of this package, which reads the token from
 * its standard input and then runs `smthrs` in its own process. A step runs beside
 * `smthrs` and reads what every process was started with, so the token is in
 * no environment. Without this install's `smthrs` there is no such command,
 * and a replay's `smthrs` gets no token.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const smthrsWithToken = (
  resolve: Resolve = fromHere,
  node: string = process.execPath
): readonly [string, ...Array<string>] | undefined => {
  const cli = directoryOf("@smthrs/cli", resolve)
  const own = directoryOf("smithers-ci", resolve)
  return cli === undefined || own === undefined
    ? undefined
    : [node, join(own, "bin", "smthrs-with-token.mjs"), join(cli, "bin", "smithers.mjs")]
}
