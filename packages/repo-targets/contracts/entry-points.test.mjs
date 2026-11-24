import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const fixture = (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gate-entry-points-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const alias = join(root, "symlink to contracts")
  symlinkSync(import.meta.dirname, alias, "dir")
  return { root, alias }
}

test("three gate entry points run through an absolute directory symlink", (t) => {
  const { root, alias } = fixture(t)
  writeFileSync(join(root, "vitest.config.ts"), "const reportsDirectory = process.pid.toString()")
  for (
    const [script, args, status, output] of [
      ["check-conflict-markers.mjs", [join(root, "missing")], 2, /conflict markers:/],
      ["check-coverage-directories.mjs", [root], 0, /coverage directories: 1/],
      ["check-tracked-hygiene.mjs", [root, "--files-from-stdin"], 0, /tracked hygiene: no dangling/]
    ]
  ) {
    const result = spawnSync(process.execPath, [join(alias, script), ...args], {
      encoding: "utf8",
      input: "",
      // The missing working directory case exercises the entry point without
      // starting the underlying version-control process.
      env: { ...process.env, PATH: "" }
    })
    assert.equal(result.status, status, result.stderr)
    assert.match(result.stdout + result.stderr, output)
  }
})

test("the shared package ESLint config excludes generated VibeLang declarations", async () => {
  const { packageConfig } = await import("../../../eslint.package.js")
  const packageRoot = join(import.meta.dirname, "../../smithers/flows/database")
  const config = await packageConfig({ tsconfigRootDir: packageRoot, bun: true })
  const ignores = config.flatMap((entry) => entry.ignores ?? [])
  for (const pattern of ["**/*.d.vibe.ts", "**/*.d.vibex.ts", "**/*.vibe.text.d.ts", "**/*.vibex.text.d.ts"]) {
    assert.ok(ignores.includes(pattern), pattern)
  }
})
