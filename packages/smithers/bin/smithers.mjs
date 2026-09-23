#!/usr/bin/env node
/**
 * The `smthrs` executable (and its `smithers` alias).
 *
 * The shebang pins Node for every installation path — `npm install -g`, `npx`,
 * and `bun x --package @smthrs/cli smthrs` — because the durable engine is
 * unsupported on Bun (the release policy). Bun honours the shebang unless
 * `--bun` is passed, and `--bun` execution of this CLI is unsupported.
 *
 * A published install ships `dist/esm/bin.js`, so the shim runs the built
 * entry. A source checkout always runs `src/bin.ts`, even when stale `dist`
 * output is present, through Node's type stripping — the same path the tests use. That
 * is what makes `pnpm exec smthrs` run the working tree during development
 * with no build step, which `scripts/check-local-smithers.mjs` requires.
 */
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { danglingWorkspaceLinkHint } from "./dangling-workspace-links.mjs"

const built = new URL("../dist/esm/bin.js", import.meta.url)
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

if (!checkout && existsSync(fileURLToPath(built))) {
  await start(built.href)
} else {
  await start(new URL("../src/bin.ts", import.meta.url).href)
}
