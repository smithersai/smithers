import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { configurations, namesCoverageByPid, pidNamedConfigurations } from "./check-coverage-directories.mjs"

const script = fileURLToPath(new URL("./check-coverage-directories.mjs", import.meta.url))

/** A throwaway checkout holding `files`. */
const checkout = (t, files) => {
  const root = mkdtempSync(join(tmpdir(), "coverage-directories-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  return root
}

const pid = "reportsDirectory: join(tmpdir(), `flows-a-coverage-${process.pid}`),\n"
const uuid = "reportsDirectory: join(tmpdir(), `flows-a-coverage-${randomUUID()}`),\n"

test("tells a pid name from the run's own", () => {
  assert.equal(namesCoverageByPid(pid), true)
  assert.equal(namesCoverageByPid("join(tmpdir(), 'flows-a-coverage-' + process.pid)"), true)
  assert.equal(namesCoverageByPid("`{{identifier}}-coverage-${ process.pid }`"), true)
  assert.equal(namesCoverageByPid(uuid), false)
  // The pid elsewhere in a configuration is no coverage name.
  assert.equal(namesCoverageByPid("const owner = process.pid\n" + uuid), false)
})

test("reads every vitest configuration of the checkout, and none of a dependency or a build", (t) => {
  const root = checkout(t, {
    "packages/a/vitest.config.ts": uuid,
    "packages/a/vitest.observe.config.ts": uuid,
    "packages/b/vitest.config.mts": uuid,
    "packages/template/vitest.config.ts.template": uuid,
    "packages/a/node_modules/dep/vitest.config.ts": pid,
    "packages/a/dist/vitest.config.js": pid,
    "packages/a/vite.config.ts": pid,
    "packages/a/src/vitest.config.helper.ts": uuid
  })
  assert.deepEqual(configurations(root), [
    "packages/a/vitest.config.ts",
    "packages/a/vitest.observe.config.ts",
    "packages/b/vitest.config.mts",
    "packages/template/vitest.config.ts.template"
  ])
  assert.deepEqual(pidNamedConfigurations(root), [])
})

test("fails naming each configuration that names its coverage directory by the pid", (t) => {
  const root = checkout(t, {
    "packages/a/vitest.config.ts": pid,
    "packages/b/vitest.config.ts": uuid,
    "packages/template/vitest.config.ts.template": "`{{identifier}}-coverage-${process.pid}`"
  })
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^packages\/a\/vitest\.config\.ts: names its coverage directory by process\.pid/m)
  assert.match(result.stderr, /^packages\/template\/vitest\.config\.ts\.template: names/m)
  assert.doesNotMatch(result.stderr, /packages\/b\//)
  assert.match(result.stderr, /2 configuration\(s\)/)
})

test("passes a checkout whose every name is the run's own", (t) => {
  const root = checkout(t, { "packages/a/vitest.config.ts": uuid })
  const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /1 vitest configurations, none named by the pid/)
})
