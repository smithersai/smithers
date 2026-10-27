import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
const page = (name) => readFileSync(new URL(`../docs/app/pages/${name}.md`, import.meta.url), "utf8")
test("quickstart follows the visitor home and repository Home before Code", () => {
  const text = page("quickstart")
  assert.match(text, /Get started for free/)
  assert.doesNotMatch(text, /top right|opens on its files|page says so and asks/)
  assert.match(text, /opens on \*\*Home\*\*/)
  assert.match(text, /Choose \*\*Code\*\*/)
  const welcome = page("welcome")
  assert.match(welcome, /Automate maintaining your codebase/)
  assert.doesNotMatch(welcome, /command that adds|top right/)
})
