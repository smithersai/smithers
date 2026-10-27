import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
test("local quickstart keeps the coding template's configured model", () => {
  const guide = readFileSync(new URL("../docs/app/pages/local-quickstart.md", import.meta.url), "utf8")
  assert.match(guide, /already sets both `seat` and `model` to `"openai:gpt-6-sol"`/)
  assert.doesNotMatch(guide, /set both.*gpt-6\.1-sol/)
})
