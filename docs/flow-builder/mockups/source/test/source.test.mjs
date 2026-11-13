import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"

test("the retired Inspector implementation and its exclusive styles stay removed", () => {
  assert.equal(existsSync(new URL("../src/components/Inspector.tsx", import.meta.url)), false)
  const styles = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8")
  assert.doesNotMatch(styles, /\.inspector(?![\w-])/)
  assert.doesNotMatch(styles, /\.inspector-(?:head|scroll|badges|block|note|notes)\b/)
  assert.doesNotMatch(styles, /\.settlement\b/)
  assert.doesNotMatch(styles, /\.port-type\[data-tone="danger"\]/)
})
