import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { test } from "node:test"
import { repoRoot } from "./workspace-packages.mjs"

const script = join(repoRoot, "scripts", "workspace-packages.mjs")

const run = (entry, cwd) => execFileSync(process.execPath, [entry], { cwd, encoding: "utf8", timeout: 30_000 })

test("the entry-point guard runs main under a symlinked, space-containing, or relative invocation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers entry ")))
  try {
    const expected = run(script, repoRoot)
    assert.match(expected, /^packages\//m)
    const linked = join(root, "linked workspace-packages.mjs")
    await symlink(script, linked)
    assert.equal(run(linked, root), expected)
    assert.equal(run(relative(root, script), root), expected)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
