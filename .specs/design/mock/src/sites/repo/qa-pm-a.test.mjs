// Exercise the actual four-site audit against real route bundles and fixture data.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import test from "node:test"

const rootPath = fileURLToPath(new URL("../../../../../../", import.meta.url))
const require = createRequire(new URL("../../../../../../package.json", import.meta.url))
test("the four-repository audit reaches its receipt with single and split blob fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repo-audit-"))
  try {
    for (const site of ["default", "smithers-site", "effeck-site", "effect"]) {
      const bundle = await require("esbuild").build({
        entryPoints: [join(rootPath, ".specs/design/mock/src/sites", site + "-main.tsx")],
        bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
        nodePaths: [join(rootPath, "node_modules")],
        define: { __SITE__: JSON.stringify(site), "process.env.NODE_ENV": JSON.stringify("production") },
        loader: { ".css": "empty" }
      })
      await mkdir(join(directory, site))
      await writeFile(join(directory, site, "index.html"), '<div id="root"></div><script type="module">' + bundle.outputFiles[0].text + '</script>')
    }
    const result = spawnSync(process.execPath, [join(rootPath, ".specs/design/mock/src/sites/repo/qa-pm-a.check.mjs"), "--build-root=" + directory], {
      encoding: "utf8", timeout: 120000, env: { ...process.env, TMPDIR: directory }
    })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const receipt = JSON.parse(await readFile(join(directory, "qa-pm-a-results.json"), "utf8"))
    assert.deepEqual(receipt.failures, [])
    assert.equal(Object.keys(receipt.counts).length, 4)
    assert.ok(receipt.checks > 100, "all repositories and their loaded blobs were checked")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
