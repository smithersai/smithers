/**
 * Copy lint's real browser and command exit agree at the card word limit.
 *
 * @since 0.1.0
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const twelve = "One two three four five six seven eight nine ten eleven twelve"
for (const { name, html, status, summary } of [
  { name: "twelve words in a card", html: `<div class="smithers-card-body"><p>${twelve}</p></div>`, status: 0, summary: "0 banned, 0 over 12 words" },
  { name: "thirteen words in a card", html: `<div class="smithers-card-body"><p>${twelve} thirteen</p></div>`, status: 1, summary: "0 banned, 1 over 12 words" },
  { name: "long text outside a card", html: `<p>${twelve} thirteen</p>`, status: 0, summary: "0 banned, 0 over 12 words" },
  { name: "quoted data inside a card", html: `<div class="smithers-card-body"><p data-copy="data">${twelve} thirteen</p></div>`, status: 0, summary: "0 banned, 0 over 12 words" },
  { name: "banned word alone", html: "<p>workflow</p>", status: 1, summary: "1 banned, 0 over 12 words" },
  { name: "both copy rules fail", html: `<div class="smithers-card-body"><p>workflow ${twelve}</p></div>`, status: 1, summary: "1 banned, 1 over 12 words" }
]) test(name, () => {
  const dist = mkdtempSync(join(tmpdir(), "copy-lint-"))
  try {
    writeFileSync(join(dist, "index.html"), `<!doctype html><main data-frame="app">${html}</main><script>window.__MOCK__ = [{ id: "copy", steps: [] }]</script>`)
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./copy.mjs", import.meta.url)), `--dist=${dist}`], { encoding: "utf8", timeout: 30_000 })
    assert.ifError(result.error)
    assert.equal(result.status, status, result.stdout + result.stderr)
    assert.ok(result.stdout.includes(summary), result.stdout)
  } finally { rmSync(dist, { recursive: true, force: true }) }
})
