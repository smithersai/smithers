#!/usr/bin/env node
/**
 * Fails when a vitest configuration names its scratch coverage directory by the
 * process id alone.
 *
 * `join(tmpdir(), \`flows-<pkg>-coverage-${process.pid}\`)` looked unique, but a
 * suite run in a pid namespace of its own (`bwrap --unshare-pid`, as the check
 * pool and the build's local slots run it) starts vitest with the same small pid
 * every time, and `--dev-bind / /` shares one /tmp. Two such runs at once on one
 * host then write and clean one directory, and one of them ends on
 * `ENOENT ... coverage-<uuid>.json` or a cut report ("Unexpected end of JSON
 * input"): a red run that no change caused (sci-job-reach, 2026-11-22). A name
 * with `randomUUID()` in it is the run's own, and the coverage provider makes
 * the directory only when it reports, so a test that imports a configuration
 * makes none.
 *
 * Every `vitest*.config.*` in the checkout counts, the package template too; a
 * dependency's or a build's copy does not.
 *
 * Usage: node packages/repo-targets/contracts/check-coverage-directories.mjs [repository root]
 * Exits 0 when every name is the run's own and 1 naming each file that is not.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { isMain } from "../scripts/workspace-root.mjs"

/** A coverage directory named by the pid: in a template string or joined with `+`. */
const pidNamed = /-coverage-(?:\$\{\s*process\.pid\s*\}|["']\s*\+\s*process\.pid\b)/

/** Whether a configuration's text names its coverage directory by the process id alone. */
export const namesCoverageByPid = (text) => pidNamed.test(text)

/** A vitest configuration file, or the package template's. */
const configuration = /^vitest(?:\.[\w-]+)?\.config\.(?:[cm]?[jt]s)(?:\.template)?$/

/** Directories that hold no configuration of this repository's own. */
const skipped = new Set(["node_modules", ".git", ".jj", "dist", "target", ".flows"])

/** Every vitest configuration under `root`, relative to it, in name order. */
export const configurations = (root) => {
  const found = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) walk(path)
      } else if (configuration.test(entry.name)) found.push(relative(root, path))
    }
  }
  walk(root)
  return found.sort()
}

/** The configurations under `root` that name their coverage directory by the pid. */
export const pidNamedConfigurations = (root) =>
  configurations(root).filter((path) => namesCoverageByPid(readFileSync(join(root, path), "utf8")))

const main = () => {
  const root = process.argv[2] ?? fileURLToPath(new URL("../../../", import.meta.url))
  const found = pidNamedConfigurations(root)
  if (found.length === 0) {
    console.log(`coverage directories: ${configurations(root).length} vitest configurations, none named by the pid`)
    return 0
  }
  for (const path of found) {
    console.error(`${path}: names its coverage directory by process.pid; use randomUUID() from node:crypto instead`)
  }
  console.error(`coverage directories: ${found.length} configuration(s) a run in a pid namespace of its own shares`)
  return 1
}

if (isMain(import.meta)) process.exitCode = main()
