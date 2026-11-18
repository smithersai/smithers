/**
 * The host tools a shell command finds by name.
 *
 * A typed rule names its tool, and the planner keys and opens exactly that
 * one. A shell command names its first program at most: `bash -e -c 'npm
 * test'` starts `npm`, which starts `node`, and a `make test` starts whatever
 * the Makefile says. So a shell target is given what the host's `PATH` gives
 * an unconfined run, `ExecSandbox.toolchain`: every `PATH` directory, each
 * tool's install root, and the links between them. Nothing else under the
 * home directory becomes readable.
 *
 * A program the command's text names is keyed by its bytes where the text is
 * read. What this adds to the key is `selections`: the bytes of each file
 * that chooses the version a shim runs, so another default version is another
 * key. A program the text does not name is readable and not keyed; keying
 * every program on `PATH` would run a target again whenever any of them is
 * updated.
 *
 * @since 1.0.0
 */

import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as NodeOs from "node:os"
import * as PackageTree from "../PackageTree.ts"

/**
 * What one `PATH` gives a shell target: what to read, the links to place, and
 * the key material.
 *
 * @category models
 * @since 1.0.0
 */
export interface HostTools {
  readonly reads: ReadonlyArray<string>
  readonly links: ReadonlyArray<{ readonly path: string; readonly target: string }>
  readonly privateLinks: ReadonlyArray<{ readonly path: string; readonly target: string }>
  /** Each file that chooses a shim's version, with the digest of its bytes. */
  readonly selections: ReadonlyArray<readonly [path: string, digest: string]>
}

/**
 * Resolves the tools on an environment's `PATH` for a workspace.
 *
 * @category resolution
 * @since 1.0.0
 */
export const resolve = async (
  root: string,
  environment: Readonly<Record<string, string | undefined>>
): Promise<HostTools> => {
  // The home is the one the command runs with, which is where its `PATH` points.
  const found = ExecSandbox.toolchain(environment["PATH"], root, {
    ...ExecSandbox.host(environment),
    home: environment["HOME"] ?? NodeOs.homedir()
  })
  const selections = await Promise.all(
    found.selections.map(async (path) => [path, await PackageTree.digestFileBytes(path)] as const)
  )
  return {
    reads: found.reads,
    links: found.links,
    privateLinks: found.privateLinks,
    selections
  }
}
