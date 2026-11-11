import * as esbuild from "esbuild"
import fc from "fast-check"
import assert from "node:assert/strict"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import vibelang from "vibelang-unplugin/esbuild"
import { BROWSER_SAFE, NODE_ONLY } from "../browser/browser-contract.mjs"
import { repoRoot } from "../scripts/workspace-packages.mjs"

const corpus = JSON.parse(readFileSync(new URL("./corpus/smithers-browser-entrypoints.json", import.meta.url), "utf8"))
const entries = [...BROWSER_SAFE, ...NODE_ONLY]

for (const entry of entries) {
  test("browser contract source: " + entry.name, () => {
    assert.ok(/\.(?:ts|vibe)$/.test(entry.entry), entry.entry)
    assert.ok(!/\.d\.(?:ts|vibe\.ts)$/.test(entry.entry), entry.entry)
    const file = resolve(repoRoot, entry.entry)
    assert.ok(existsSync(file), entry.name + " names a missing source: " + entry.entry)
    assert.ok(statSync(file).isFile(), entry.entry)
  })
}

const packageRoot = (file) => {
  for (let directory = dirname(file);; directory = dirname(directory)) {
    if (existsSync(join(directory, "package.json"))) return directory
    assert.notEqual(dirname(directory), directory, file)
  }
}

test("mixed source registry entries bundle for browsers and workers", { timeout: 180_000 }, async () => {
  const sources = corpus.browserBundleSources.map((name) => {
    const entry = BROWSER_SAFE.find((row) => row.name === name)
    assert.ok(entry, name)
    return entry
  })
  for (const name of corpus.migratedSources) assert.ok(entries.some((entry) => entry.name === name), name)
  const native = sources.find((entry) => entry.name === "@smthrs/jj/browser/BrowserJj")
  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...sources), fc.boolean(), fc.boolean(), async (entry, worker, treeShaking) => {
      const result = await esbuild.build({
        entryPoints: [resolve(repoRoot, entry.entry)],
        absWorkingDir: repoRoot,
        plugins: [vibelang({ root: packageRoot(resolve(repoRoot, entry.entry)) })],
        bundle: true,
        write: false,
        platform: "browser",
        conditions: worker ? ["workerd", "worker", "browser"] : [],
        format: "esm",
        target: "es2022",
        treeShaking,
        metafile: true,
        logLevel: "silent"
      })
      assert.ok(result.outputFiles.some((file) => file.contents.length > 0), entry.name)
      assert.ok(Object.keys(result.metafile.inputs).some((file) => file.endsWith(entry.entry)), entry.entry)
    }),
    { numRuns: 12, seed: 60717, examples: [[native, false, false], [native, true, true]] }
  )
})
