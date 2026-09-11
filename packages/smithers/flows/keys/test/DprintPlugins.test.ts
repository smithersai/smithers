import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

const plugins: ReadonlyArray<string> =
  JSON.parse(readFileSync(new URL("../dprint.json", import.meta.url), "utf8")).plugins

it.each(plugins)("%s is pinned to a sha256 checksum", (plugin) => {
  expect(plugin).toMatch(/^https:\/\/plugins\.dprint\.dev\/[a-z]+-\d+\.\d+\.\d+\.wasm@[0-9a-f]{64}$/)
})
