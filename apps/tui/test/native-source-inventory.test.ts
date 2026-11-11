import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test as nodeTest } from "node:test"
import { fileURLToPath } from "node:url"

const title = "retains every logical source when TypeScript modules become native modules"
const verify = async () => {
  const { checkSourceCoverage } = await import("../coverage-inventory.mjs")
  const root = fileURLToPath(new URL("../", import.meta.url))
  const manifest = JSON.parse(readFileSync(new URL("../coverage-source-manifest.json", import.meta.url), "utf8"))
  const inventory = checkSourceCoverage(root, manifest)
  assert.deepEqual(inventory.logical, manifest)
}

if (typeof Bun === "undefined") nodeTest(title, verify)
else {
  const { test } = await import("bun:test")
  test(title, verify)
}
