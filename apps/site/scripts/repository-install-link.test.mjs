import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
test("repository Install Smithers opens installation rather than the landing page", () => {
  const home = JSON.parse(readFileSync(new URL("../../../.smithers/home.json", import.meta.url), "utf8"))
  const links = home.blocks.flatMap((block) => block.links ?? [])
  assert.equal(links.find((link) => link.label === "Install Smithers").url, "https://smithers.sh/docs/installation/")
})
