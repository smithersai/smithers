import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("sd4-ia-7: inline code is atomic while long values can still wrap", () => {
  const css = readFileSync(new URL("../../src/styles/starlight.css", import.meta.url), "utf8")
  const code = css.match(/\.sl-markdown-content :not\(pre\) > code\s*\{([^}]+)\}/)?.[1]
  assert.ok(code)
  assert.match(code, /display: inline-block/)
  assert.match(code, /max-inline-size: 100%/)
  assert.match(code, /overflow-wrap: anywhere/)
})
