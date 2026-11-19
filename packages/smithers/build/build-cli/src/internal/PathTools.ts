/**
 * The directory that leads a spawn's `PATH` with exactly its declared tools.
 *
 * A `tools` entry keys by the bytes of one resolved executable, and the
 * command finds it by name. Searching the host `PATH` again at spawn finds
 * whatever comes first there, and under confinement whatever the sandbox
 * happens to mount: a system Node behind a workspace-local one, the Go
 * launcher behind the SDK it selected. Each name here is a link to the one
 * planned executable, so nothing else can answer it.
 *
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { errorCode } from "./Fs.ts"

/** A shared tool directory that holds other tools than the target declares. */
class ToolDirectoryClash extends Data.TaggedError("smithers-build/ToolDirectoryClash")<{ readonly message: string }> {}

/**
 * One tool a command finds by name, at its absolute host path.
 *
 * @category models
 * @since 1.0.0
 */
export interface Tool {
  readonly name: string
  readonly path: string
}

const holds = async (directory: string, tools: ReadonlyArray<Tool>): Promise<boolean> => {
  let names: Array<string>
  try {
    names = await Fs.readdir(directory)
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false
    throw cause
  }
  if (names.length !== tools.length) return false
  for (const tool of tools) {
    const target = await Fs.readlink(NodePath.join(directory, tool.name)).catch(() => undefined)
    if (target !== tool.path) return false
  }
  return true
}

/**
 * Materializes the tool directory `path-<id>` under `parent` and returns its
 * path. Concurrent spawns of one node share it: it is built aside and renamed
 * into place, so no spawn ever reads a directory missing one of its tools.
 *
 * `parent` lies in one workspace and `id` is the node's key, so a directory
 * already there names the same tools. One that names others is refused, never
 * trusted or rewritten under another run.
 *
 * @category execution
 * @since 1.0.0
 */
export const directory = async (parent: string, id: string, tools: ReadonlyArray<Tool>): Promise<string> => {
  const final = NodePath.join(parent, `path-${id}`)
  if (await holds(final, tools)) return final
  await Fs.mkdir(parent, { recursive: true })
  const staging = await Fs.mkdtemp(NodePath.join(parent, `path-${id}.`))
  try {
    for (const tool of tools) await Fs.symlink(tool.path, NodePath.join(staging, tool.name))
    await Fs.rename(staging, final)
    return final
  } catch (cause) {
    await Fs.rm(staging, { recursive: true, force: true })
    const code = errorCode(cause)
    if (code !== "ENOTEMPTY" && code !== "EEXIST") throw cause
  }
  // Another spawn of this node renamed its copy first.
  if (await holds(final, tools)) return final
  throw new ToolDirectoryClash({
    message: `tool directory ${final} holds other tools than this target declares; remove it and run again`
  })
}

/**
 * The line a program prints when a run starts it without declaring it;
 * `CacheEvidence.deniedLines` reads it.
 *
 * @category execution
 * @since 1.0.0
 */
export const undeclaredLine = (name: string): string => `sandbox: ${name} is not declared: declare it in tools`

const answer = (name: string): string =>
  ["#!/bin/sh", `echo '${undeclaredLine(name).replaceAll("'", "'\\''")}' >&2`, "exit 127", ""].join("\n")

/**
 * Materializes the directory that ends a confined suite's `PATH`: one script
 * for each program a host `PATH` directory holds and the suite does not
 * declare, which fails naming that program. A confined run is not shown the
 * host's own tool directories, so without it a test that looks a program up
 * would skip, or take another path, where the workspace's run starts it.
 * Programs the run is shown come earlier on `PATH` and answer first.
 *
 * @category execution
 * @since 1.0.0
 */
export const undeclared = async (
  parent: string,
  searchPath: string,
  declared: ReadonlyArray<string>
): Promise<string> => {
  const names = new Set<string>()
  for (const entry of searchPath.split(NodePath.delimiter)) {
    if (!NodePath.isAbsolute(entry)) continue
    for (const name of await Fs.readdir(entry).catch(() => [])) {
      if (!name.startsWith(".") && !declared.includes(name)) names.add(name)
    }
  }
  const sorted = [...names].sort()
  const id = createHash("sha256").update(sorted.join("\0")).digest("hex").slice(0, 16)
  const final = NodePath.join(parent, `undeclared-${id}`)
  if (await Fs.stat(final).then(() => true, () => false)) return final
  await Fs.mkdir(parent, { recursive: true })
  const staging = await Fs.mkdtemp(NodePath.join(parent, `undeclared-${id}.`))
  for (const name of sorted) await Fs.writeFile(NodePath.join(staging, name), answer(name), { mode: 0o755 })
  // Another run with the same names may have renamed its copy first; it holds the same scripts.
  await Fs.rename(staging, final).catch(() => Fs.rm(staging, { recursive: true, force: true }))
  return final
}
