/**
 * Where this install keeps what a replay needs to run in a stranger's
 * checkout: the `smthrs` program, and a Node to run it on.
 *
 * @since 0.1.0
 */

import { realpathSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { delimiter, dirname, join } from "node:path"

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

const isProgram = (path: string, self: string): boolean => {
  try {
    return statSync(path).isFile() && realpathSync(path) !== self
  } catch {
    return false
  }
}

/**
 * The Node that runs `smthrs`, which does not run on Bun. Under Node it is this
 * process. Under Bun it is the first `node` on the path that is not Bun itself:
 * `bunx` puts a `node` link to Bun on the path of a machine with no Node.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const nodeProgram = (
  path: string | undefined,
  versions: Readonly<Record<string, string | undefined>> = process.versions,
  self: string = process.execPath
): string | undefined => {
  if (versions["bun"] === undefined) return self
  const bun = realpathSync(self)
  return (path ?? "").split(delimiter).map((directory) => join(directory, "node")).find((node) => isProgram(node, bun))
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
