/**
 * Where this install keeps the two things a replay needs inside a stranger's
 * checkout: the `smthrs` program, and the targets package a generated
 * workspace imports.
 *
 * @since 0.1.0
 */

import { createRequire } from "node:module"
import { dirname, join } from "node:path"

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

/**
 * The command that starts this install's `smthrs`: the one `smithers-ci`
 * depends on, run by the Node that runs `smithers-ci`. Without it, the
 * `smthrs` on the path.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const smthrsCommand = (resolve: Resolve = fromHere): readonly [string, ...Array<string>] => {
  const cli = directoryOf("@smthrs/cli", resolve)
  return cli === undefined ? ["smthrs"] : [process.execPath, join(cli, "bin", "smithers.mjs")]
}

/**
 * The directory of this install's `@smthrs/targets` package, which a
 * generated `PACKAGE.ts` imports.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const targetsDirectory = (resolve: Resolve = fromHere): string | undefined =>
  directoryOf("@smthrs/targets", resolve)
