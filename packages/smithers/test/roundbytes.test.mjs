/** Deterministic SQLite bytes gate; timings are retained, never asserted. */
import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

test("800 rounds retain only live cursor mappings and append bounded state and journal bytes", { timeout: 600_000 }, () => {
  const child = spawnSync(process.execPath, ["test/roundbytes.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, ROUND_BYTES_SIZE: "800", ROUND_BYTES_KINDS: "synthetic,file-tree", ROUND_BYTES_NODES: "1", ROUND_BYTES_ASSERT: "1",
      ROUND_BYTES_OUT: `test-results/roundbytes-${Date.now()}` }, encoding: "utf8", timeout: 590_000, maxBuffer: 8 * 1024 * 1024
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stdout.slice(-4000) + child.stderr.slice(-4000))
})
