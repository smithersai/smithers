import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./check-llms.mjs", import.meta.url))

const fixture = (t, files) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-check-llms-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return spawnSync(process.execPath, [script, root], { encoding: "utf8", timeout: 30_000 })
}

test("an llms.txt carrying Electrobun boilerplate fails the check and is named", (t) => {
  const run = fixture(t, {
    "apps/llms.txt": "# Electrobun Project\n\nThis is an Electrobun desktop application.\n",
    "apps/site/public/llms.txt": "# Smithers\n"
  })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /electrobun boilerplate: apps\/llms\.txt/)
  assert.doesNotMatch(run.stderr, /apps\/site\/public\/llms\.txt/)
})

test("Smithers llms bundles pass, and vendored copies under node_modules are ignored", (t) => {
  const run = fixture(t, {
    "apps/site/public/llms.txt": "# Smithers\n",
    "apps/site/public/llms-full.txt": "# Smithers full\n",
    "node_modules/electrobun/llms.txt": "# Electrobun Project\n"
  })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /check-llms: clean/)
})
