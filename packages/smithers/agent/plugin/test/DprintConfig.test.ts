import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const config = JSON.parse(readFileSync(fileURLToPath(new URL("../dprint.json", import.meta.url)), "utf8")) as {
  readonly plugins: ReadonlyArray<string>
}

describe("dprint.json", () => {
  it("pins every WASM plugin URL to a sha256 so dprint verifies the download", () => {
    expect(config.plugins.length).toBeGreaterThan(0)
    for (const plugin of config.plugins) {
      expect(plugin).toMatch(/^https:\/\/plugins\.dprint\.dev\/.+\.wasm@[0-9a-f]{64}$/)
    }
  })
})
