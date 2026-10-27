import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
test("hosted docs do not advertise a CLI release as the product version", () => {
  const config = readFileSync(new URL("../astro.config.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(config, /routeMiddleware:.*docs-notice/)
  assert.equal(existsSync(new URL("./docs-notice.mjs", import.meta.url)), false)
})
