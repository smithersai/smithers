/**
 * The release's gates on its packed tarballs, in the order the publish job
 * runs them: pack, then the install smoke of every package, then
 * `smithers-ci` from its tarball, then the installed `smthrs` as one file.
 *
 * The publish job's "Pack and smoke-test release artifacts" step runs this
 * file, so a checkout of `main` runs the same list between releases.
 *
 * usage: node .smithers/flows/release/pack-gates.mjs [pack-directory]
 *
 * With a directory, as the release passes it, the packages must already be
 * built and the pack rebuilds each one. With none, it builds every library
 * through the build graph, packs what it built into a temporary directory and
 * removes that directory afterwards. A pack made here carries no native
 * helpers (the release downloads them for every platform), so the installed
 * CLI is given the `smithers-jj-export` this checkout builds, as ci.yml gives
 * its tests: unless `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` or
 * `SMITHERS_NATIVE_HELPERS_DIR` already names one, it is built with cargo.
 *
 * Each gate runs on the `node` the path names, so the release's floor check
 * holds for all of them. The first red gate stops the rest, with its exit code.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url))

/** Each gate's program, relative to the repository root, given the pack directory. */
const packGates = [
  ".smithers/flows/release/pack-release.mjs",
  ".smithers/flows/release/smoke-release.mjs",
  "packages/ci/test/package/tarball.e2e.mjs",
  "packages/smithers/test/published-layout.e2e.mjs"
]

/** Runs one step; its exit code, or 0. */
const step = (command, args) => {
  console.error(`pack-gates: ${[command, ...args].join(" ")}`)
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit" })
  if (result.error !== undefined) throw result.error
  if (result.status === 0) return 0
  console.error(`pack-gates: ${command === "node" ? args[0] : [command, ...args].join(" ")} failed with exit ${result.status ?? result.signal}`)
  return result.status ?? 1
}

const [given, ...rest] = process.argv.slice(2)
if (rest.length > 0) {
  console.error("usage: node .smithers/flows/release/pack-gates.mjs [pack-directory]")
  process.exit(2)
}
const directory = given === undefined ? mkdtempSync(join(tmpdir(), "smithers-pack-gates-")) : resolve(given)
const helperNamed = process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"] !== undefined ||
  process.env["SMITHERS_NATIVE_HELPERS_DIR"] !== undefined
const buildsHelper = given === undefined && !helperNamed
if (buildsHelper) {
  process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"] = join(
    repositoryRoot,
    "target/debug",
    process.platform === "win32" ? "smithers-jj-export.exe" : "smithers-jj-export"
  )
}
const steps = [
  ...(given === undefined ? [["pnpm", ["exec", "smthrs", "build", "//packages/...:lib"]]] : []),
  ...(buildsHelper ? [["cargo", ["build", "--locked", "-p", "smithers-ffi", "--bin", "smithers-jj-export"]]] : []),
  ...packGates.map((gate, index) => ["node", index === 0 && given === undefined ? [gate, directory, "--built"] : [gate, directory]])
]
let status = 0
try {
  for (const [command, args] of steps) {
    status = step(command, args)
    if (status !== 0) break
  }
} finally {
  if (given === undefined) rmSync(directory, { recursive: true, force: true })
}
process.exitCode = status
