import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test("the build removes only the noindex bug redirect from every sitemap chunk", async () => {
  const root = await mkdtemp(join(tmpdir(), "site-sitemap-"))
  try {
    const keep = "<url><loc>https://example.test/docs/</loc></url>"
    for (const [index, path] of ["/bug/", "/bug"].entries()) {
      await writeFile(join(root, `sitemap-${index}.xml`), `<urlset>${keep}<url><loc>https://example.test${path}</loc></url></urlset>`)
    }
    await writeFile(join(root, "sitemap-index.xml"), "index")
    execFileSync(process.execPath, [new URL("filter-sitemap.mjs", import.meta.url).pathname, root])
    for (const index of [0, 1]) assert.equal(await readFile(join(root, `sitemap-${index}.xml`), "utf8"), `<urlset>${keep}</urlset>`)
    assert.equal(await readFile(join(root, "sitemap-index.xml"), "utf8"), "index")
  } finally { await rm(root, { recursive: true, force: true }) }
})


test("the real build filters the generated sitemap before validating its output", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.match(pkg.scripts.build, /astro build && node scripts\/filter-sitemap.mjs dist && node scripts\/check-built-site.mjs/)
})
