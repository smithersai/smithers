import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("SD4-COPY-4: current flow instructions do not claim default wiki configuration", () => {
  const text = readFileSync(new URL("../../docs/app/pages/flows.md", import.meta.url), "utf8")
  assert.doesNotMatch(text, /default wiki pages/)
})
