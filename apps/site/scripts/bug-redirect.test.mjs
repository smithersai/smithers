import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("the legacy bug door opens the in-app form without preparing a GitHub issue", async () => {
  const page = readFileSync(new URL("../src/pages/bug.astro", import.meta.url), "utf8")
  const frontmatter = page.split("---")[1]
  let destination
  await new Function("Astro", "env", frontmatter.replaceAll("import.meta.env", "env"))({ redirect: (url) => { destination = url } }, {})
  assert.equal(destination, "/app/bugs/report")
})
