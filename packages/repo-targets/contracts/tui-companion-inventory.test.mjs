/**
 * Native module parts preserve complete source coverage.
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { repoRoot } from "../scripts/workspace-packages.mjs"

const require = createRequire(import.meta.url)
const fc = require("fast-check")
const helper = pathToFileURL(join(repoRoot, "apps/tui/coverage-inventory.mjs")).href
const corpus = JSON.parse(readFileSync(new URL("./corpus/smithers-tui-companion-ownership.json", import.meta.url), "utf8"))
const put = (root, path, text = "export const value = 1\n") => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const scratch = async body => {
  const root = mkdtempSync(join(tmpdir(), "source-companion-ownership-"))
  try { await body(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test("throwing declarations and runtime platform parts retain their original module identity", async () => {
  const { writeTypeScriptRoster } = await import(helper)
  await scratch(root => {
    for (const path of ["src/branch.vibe", "src/view.tsx", corpus.runtime, corpus.throwing]) put(root, path)
    const value = writeTypeScriptRoster(root, corpus.witness)
    assert.deepEqual(value.logical, corpus.witness)
    assert.deepEqual(value.platform, [corpus.runtime])
    assert.deepEqual(value.companions, [corpus.throwing])
    assert.ok(value.typescript.includes(corpus.runtime))
    assert.deepEqual(JSON.parse(readFileSync(join(root, "coverage-roster.json"), "utf8")), value.typescript)
  })
})

test("a removed runtime platform source cannot disappear through regeneration", async () => {
  const { writeTypeScriptRoster } = await import(helper)
  await scratch(root => {
    for (const path of ["src/branch.vibe", "src/view.tsx", corpus.runtime]) put(root, path)
    writeTypeScriptRoster(root, corpus.witness)
    const before = readFileSync(join(root, "coverage-roster.json"))
    unlinkSync(join(root, corpus.runtime))
    assert.throws(() => writeTypeScriptRoster(root, corpus.witness), /Missing physical source/)
    assert.deepEqual(readFileSync(join(root, "coverage-roster.json")), before)
  })
})

test("original platform identities and orphan companions cannot be absorbed", async () => {
  const { checkSourceCoverage } = await import(helper)
  await scratch(root => {
    put(root, "src/branch.vibe")
    put(root, corpus.runtime)
    const manifest = [corpus.runtime, "src/branch.ts"].sort()
    const value = checkSourceCoverage(root, manifest)
    assert.deepEqual(value.logical, manifest)
    assert.deepEqual(value.platform, [])
    unlinkSync(join(root, corpus.runtime))
    assert.throws(() => checkSourceCoverage(root, manifest), /missing/)
    put(root, "src/orphan.vibe.throwing.d.ts")
    assert.throws(() => checkSourceCoverage(root, ["src/branch.ts"]), /extra/)
    unlinkSync(join(root, "src/orphan.vibe.throwing.d.ts"))
    put(root, "src/orphan.platform.ts")
    assert.throws(() => checkSourceCoverage(root, ["src/branch.ts"]), /extra/)
  })
})

test("generated native subsets retain every physical runtime part and all logical sources", async () => {
  const { writeTypeScriptRoster } = await import(helper)
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 10 }),
    fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
    fc.boolean(),
    async (count, native, types) => scratch(root => {
      const manifest = []
      for (let index = 0; index < count; index++) {
        const stem = "src/deep/module" + index
        manifest.push(stem + ".ts")
        if (native[index % native.length]) {
          put(root, stem + ".vibe")
          put(root, stem + ".platform.ts")
          if (types) {
            put(root, stem + ".vibe.throwing.d.ts")
            put(root, stem + ".vibe.platform.d.ts")
            put(root, stem + ".d.vibe.ts")
          }
        } else put(root, stem + ".ts")
      }
      manifest.sort()
      const value = writeTypeScriptRoster(root, manifest)
      assert.deepEqual(value.logical, manifest)
      assert.equal(value.logical.length, count)
      assert.equal(value.native.length + value.typescript.length - value.companions.length - value.platform.length, count)
      assert.equal(value.platform.length, value.native.length)
      assert.ok(value.platform.every(path => value.typescript.includes(path)))
    })
  ), { numRuns: 96, examples: [[2, [true, false], true], [1, [true], false]] })
})
