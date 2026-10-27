import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
test("hosted docs do not advertise a CLI release as the product version", () => {
  const config = readFileSync(new URL("../astro.config.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(config, /routeMiddleware:.*docs-notice/)
  assert.equal(existsSync(new URL("./docs-notice.mjs", import.meta.url)), false)
})
test("docs backgrounds and text match the current product palette in both themes", () => {
  const css = readFileSync(new URL("../src/styles/starlight.css", import.meta.url), "utf8")
  const theme = readFileSync(new URL("../../../packages/smithers/ui/ui-styleguide/src/themes/paper.ts", import.meta.url), "utf8")
  for (const color of ["#f7f4ee", "#211d18", "#665f54", "#0d1514", "#ece7db", "#a8a193", "#45c4b2", "#0f766e"]) {
    assert.ok(theme.includes(color))
    assert.ok(css.includes(color), `docs must use ${color}`)
  }
})
