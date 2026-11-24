/**
 * The root `projectCopy` target declares every file its generator changes.
 *
 * `//:projectCopy` runs `apps/site/scripts/generate-project-copy.mjs` confined
 * to the paths its `changes` list names, and keys its cache on them. The list
 * once named two retired pages and left out `apps/site/docs/installation.mdx`,
 * which the generator rewrites (R2-Neon-D3-011). This suite runs the generator
 * in a copy of the tree where every file it owns is out of date, records what
 * it wrote and deleted, and compares that with the declared list.
 *
 * Run it with `node --test packages/repo-targets/contracts/project-copy-changes.test.mjs`.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { test } from "node:test"

import { repoRoot } from "../scripts/workspace-packages.mjs"

const script = "apps/site/scripts/generate-project-copy.mjs"
const source = "apps/site/src/data/project.json"
// The pages M-35 retired; the generator deletes one that reappears.
const retired = ["apps/site/src/content/docs/docs/index.mdx", "apps/site/src/content/docs/docs/developers.mdx"]

/** The `changes` list of the `projectCopy` target, read from the root PACKAGE.ts. */
const declaredChanges = () => {
  const text = readFileSync(join(repoRoot, "PACKAGE.ts"), "utf8")
  const target = /const projectCopy = Smithers\.Generate\(\{[\s\S]*?\n\}\)/.exec(text)
  assert.ok(target, "PACKAGE.ts declares the projectCopy target")
  const changes = /\n  changes: (\[[^\]]*\])/.exec(target[0])
  assert.ok(changes, "projectCopy declares its changes")
  return JSON.parse(changes[1].replace(/,\s*\]$/, "]"))
}

/** Every file under `root`, as a path from it, with its text. */
const snapshot = (root) =>
  new Map(
    readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return [relative(root, path), readFileSync(path, "utf8")]
    })
  )

test("projectCopy declares exactly the files its generator writes and deletes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-project-copy-changes-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of [script, source, "apps/site/docs/installation.mdx", "package.json"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    cpSync(join(repoRoot, path), join(root, path))
  }
  // Out of date everywhere: a new description, no README, and both retired pages back.
  const project = JSON.parse(readFileSync(join(root, source), "utf8"))
  project.description = "A description no committed file carries."
  writeFileSync(join(root, source), JSON.stringify(project))
  for (const path of retired) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), "retired\n")
  }

  const before = snapshot(root)
  const generate = (...args) => spawnSync(process.execPath, [join(root, script), ...args], { encoding: "utf8" })
  const drift = generate("--check")
  assert.equal(drift.status, 1, drift.stdout + drift.stderr)
  assert.deepEqual(snapshot(root), before, "a check changes nothing")
  const written = generate()
  assert.equal(written.status, 0, written.stdout + written.stderr)
  const after = snapshot(root)
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path))

  assert.deepEqual(changed.filter((path) => !after.has(path)).sort(), [...retired].sort(), "the retired pages are deleted")
  assert.ok(changed.includes("apps/site/docs/installation.mdx"), "the installation page is rewritten")
  assert.deepEqual([...declaredChanges()].sort(), changed.sort())
  assert.equal(generate("--check").status, 0)
})
