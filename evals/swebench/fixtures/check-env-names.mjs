/**
 * Asserts every environment variable the rig exports to the CLI is one the
 * CLI reads.
 *
 *   node fixtures/check-env-names.mjs
 *
 * `packages/smithers/src/Environment.ts` is the closed list of `SMITHERS_*`
 * names the CLI reads. From 2026-08 to 2026-09-22 `run-instance.sh` exported
 * `FLOWS_TEST_COMMAND`, `FLOWS_TEST_CONTAINER`, `FLOWS_TEST_CWD` and
 * `FLOWS_OPENAI_AUTH`: names nothing read. The `test` flow was never bound, and
 * a lane asked for the chatgpt seat fell back to `OPENAI_API_KEY` without a
 * word, because an unset `SMITHERS_OPENAI_AUTH` means `api-key`. r91 measured
 * the first symptom as zero `test` calls across 45 journals; the second was
 * never measured, which is the point.
 *
 * The check reads the scripts as text. Every `export NAME=` whose NAME is
 * `FLOWS_*` or `SMITHERS_*` must be in the CLI's list. The rig's own knobs are
 * `SWB_*` and are not the CLI's business, so they are not checked here.
 *
 * Offline, spends nothing, needs no docker.
 *
 * @since 1.0.0
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const rig = resolve(import.meta.dirname, "..")
const root = resolve(rig, "../..")

const environmentSource = readFileSync(join(root, "packages/smithers/src/Environment.ts"), "utf8")
const read = new Set(
  [...environmentSource.matchAll(/entry\(\s*"([A-Z0-9_]+)"/g)].map((match) => `SMITHERS_${match[1]}`)
)
assert.ok(read.has("SMITHERS_OPENAI_AUTH"), "Environment.ts still lists SMITHERS_OPENAI_AUTH")
assert.ok(read.has("SMITHERS_TEST_COMMAND"), "Environment.ts still lists SMITHERS_TEST_COMMAND")

const scripts = [
  ...readdirSync(rig).filter((name) => name.endsWith(".sh")).map((name) => join(rig, name)),
  ...readdirSync(join(rig, "lib")).filter((name) => name.endsWith(".sh")).map((name) => join(rig, "lib", name))
]
assert.ok(scripts.some((path) => path.endsWith("/run-instance.sh")), "run-instance.sh is among the scripts checked")

const unread = []
const exported = new Set()
for (const path of scripts) {
  const text = readFileSync(path, "utf8")
  for (const match of text.matchAll(/^\s*export\s+((?:FLOWS|SMITHERS)_[A-Z0-9_]+)=/gm)) {
    exported.add(match[1])
    if (!read.has(match[1])) unread.push(`${path.slice(rig.length + 1)}: ${match[1]}`)
  }
}
assert.deepEqual(unread, [], `exports the CLI does not read:\n  ${unread.join("\n  ")}`)

// The lane must still declare the four things the CLI needs from it; a rename
// that drops one would pass the check above by exporting nothing.
for (const name of ["SMITHERS_TEST_COMMAND", "SMITHERS_TEST_CONTAINER", "SMITHERS_TEST_CWD", "SMITHERS_OPENAI_AUTH"]) {
  assert.ok(exported.has(name), `run-instance.sh exports ${name}`)
}

console.log(`check-env-names.mjs: ${exported.size} exports across ${scripts.length} scripts, all read by the CLI.`)
