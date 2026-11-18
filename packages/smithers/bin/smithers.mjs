#!/usr/bin/env node
/**
 * The `smthrs` executable (and its `smithers` alias).
 *
 * The shebang pins Node for every installation path — `npm install -g`, `npx`,
 * and `bun x --package @smthrs/cli smthrs` — because the durable engine is
 * unsupported on Bun (the release policy). Bun honours the shebang unless
 * `--bun` is passed, and `--bun` execution of this CLI is unsupported.
 *
 * A published install ships the program twice: `dist/bundle/bin.js`, the whole
 * program as one file, and `dist/esm/bin.js`, the same program as the separate
 * modules other packages import. The shim runs the one file: a start then
 * loads one file where the separate modules are about 3,000, and Node keeps
 * its compiled code between starts (see `keepCompiledCode`). The separate
 * modules run when the installation has no bundle, and on a Node older than
 * the supported one, which is how that Node still gets the line that names
 * the Node it needs.
 *
 * A source checkout always runs `src/bin.ts`, even when stale `dist`
 * output is present, through Node's type stripping — the same path the tests use. That
 * is what makes `pnpm exec smthrs` run the working tree during development
 * with no build step, which `packages/smithers/test/support/check-local-smithers.mjs` requires.
 */
import { existsSync, readdirSync, rmSync } from "node:fs"
import * as Module from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { danglingWorkspaceLinkHint } from "./dangling-workspace-links.mjs"

const built = new URL("../dist/esm/bin.js", import.meta.url)
const bundle = new URL("../dist/bundle/bin.js", import.meta.url)
// A checkout may also have old build output; only registry installations use it.
const checkout = existsSync(new URL("../../../pnpm-workspace.yaml", import.meta.url))

/**
 * Imports the entry, and explains the one failure whose message names the
 * wrong problem: a checkout whose workspace links point into a git worktree
 * that has since been removed fails with `ERR_MODULE_NOT_FOUND` for a package
 * that is right there in the tree. The 0.x bin diagnosed this; without the
 * diagnosis the reader looks for a build problem that does not exist.
 */
const start = async (entry) => {
  try {
    await import(entry)
  } catch (cause) {
    if (cause?.code !== "ERR_MODULE_NOT_FOUND") throw cause
    const hint = danglingWorkspaceLinkHint(dirname(fileURLToPath(import.meta.url)))
    if (hint === null) throw cause
    process.stderr.write(`${hint}\n`)
    throw cause
  }
}

/**
 * Whether this start runs the one file. The bundle names every Node builtin
 * the program uses when it loads, so it loads only on a supported Node; an
 * older one runs the separate modules, whose entry refuses it by name. Bun,
 * which the CLI does not support, keeps running what it ran before.
 */
const bundled = async () => {
  if (checkout || process.versions.bun !== undefined || typeof Module.registerHooks !== "function") return false
  if (!existsSync(fileURLToPath(bundle))) return false
  const { satisfies } = await import(new URL("../dist/esm/internal/NodeVersion.js", import.meta.url).href)
  return satisfies(process.versions.node)
}

/** How many files the launcher's own directory of compiled code holds before the launcher empties it. */
const compiledFilesLimit = 512

/**
 * Has Node keep the code it compiles between starts, which takes about 0.4 s
 * off each one. `NODE_DISABLE_COMPILE_CACHE=1` turns it off.
 *
 * Node writes one file per module it compiles and never removes one. The
 * bundle and the packages beside it are the same modules every start. A
 * workspace's declaration files are loaded under a new address each start, so
 * every start leaves about four small files that no later start reads. In a
 * directory the person names with `NODE_COMPILE_CACHE` those are theirs to
 * keep or clear. Otherwise the launcher uses a directory of its own under the
 * temporary directory and empties it once it holds more than
 * {@link compiledFilesLimit} files: about one start in a hundred then
 * compiles the bundle again.
 */
const keepCompiledCode = () => {
  if (process.env.NODE_DISABLE_COMPILE_CACHE) return
  if (process.env.NODE_COMPILE_CACHE) {
    Module.enableCompileCache()
    return
  }
  const directory = join(tmpdir(), `smthrs-compile-cache-${process.getuid?.() ?? "user"}`)
  try {
    if (readdirSync(directory, { recursive: true }).length > compiledFilesLimit) {
      rmSync(directory, { recursive: true, force: true })
    }
  } catch {
    // Not there yet, or another start is emptying it: Node makes it again.
  }
  Module.enableCompileCache(directory)
}

if (await bundled()) {
  keepCompiledCode()
  // The bundle's imports of packages left outside it resolve from the package that imports them.
  const { resolveHooks } = await import("./bundle-origin.mjs")
  Module.registerHooks(resolveHooks(bundle.href))
  await start(bundle.href)
} else if (!checkout && existsSync(fileURLToPath(built))) {
  await start(built.href)
} else {
  await start(new URL("../src/bin.ts", import.meta.url).href)
}
