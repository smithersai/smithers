import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
test("flows defines protected actions and the supported personal edit action at first use", () => {
  const text = readFileSync(new URL("../docs/app/pages/flows.md", import.meta.url), "utf8")
  assert.match(text, /System flows are protected actions/)
  assert.match(text, /On Flows, \*\*Edit\*\* starts a draft from the saved flow/ )
  assert.doesNotMatch(text, /\/flow\.edit|\/flow\.source/)
  assert.match(text, /personal revisions do not replace them/)
})
