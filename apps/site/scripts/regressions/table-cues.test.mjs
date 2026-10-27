import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("sd4-ia-6: documentation tables define scroll shadows that uncover with the content", () => {
  const css = readFileSync(new URL("../../src/styles/starlight.css", import.meta.url), "utf8")
  const table = css.match(/\.sl-markdown-content table\s*\{([^}]+)\}/)?.[1]
  assert.ok(table)
  assert.equal((table.match(/no-repeat local/g) ?? []).length, 2)
  assert.equal((table.match(/no-repeat scroll/g) ?? []).length, 2)
  assert.equal((table.match(/radial-gradient/g) ?? []).length, 2)
})
