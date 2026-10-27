import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
test("flows defines protected actions and proposed improvements at first use", () => {
  const text = readFileSync(new URL("../docs/app/pages/flows.md", import.meta.url), "utf8")
  assert.match(text, /System flows are protected actions/)
  assert.match(text, /In Chat, type `\/flow.edit todo`/)
  assert.match(text, /Learning proposals are suggested improvements/)
})
