/**
 * Native source renames cannot remove modules from terminal source coverage.
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
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
const corpus = JSON.parse(readFileSync(new URL("./corpus/smithers-tui-source-inventory.json", import.meta.url), "utf8"))
const write = (root, path, text = "export const value = 1\n") => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const scratch = async (body) => {
  const root = mkdtempSync(join(tmpdir(), "native-source-inventory-"))
  try { await body(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test("the unchanged TypeScript-only test cannot detect a missing native source, and the complete guard does", async () => {
  await scratch(async root => {
    const original = readFileSync(join(repoRoot, "apps/tui/test/coverage-roster.test.ts"))
    write(root, "test/coverage-roster.test.ts", original)
    write(root, "src/view.tsx")
    write(root, "coverage-roster.json", JSON.stringify(["src/view.tsx"]))
    const legacy = spawnSync("bun", ["test", "test/coverage-roster.test.ts"], { cwd: root, encoding: "utf8" })
    assert.equal(legacy.error, undefined)
    assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr)
    assert.match(legacy.stdout + legacy.stderr, /1 pass/)
    const { checkSourceCoverage } = await import(helper)
    assert.throws(() => checkSourceCoverage(root, corpus.witness), /missing.*src\/branch\.ts/)
    write(root, "src/branch.vibe")
    assert.deepEqual(checkSourceCoverage(root, corpus.witness).logical, corpus.witness)
  })
})

test("regeneration retains all original logical identifiers across generated native subsets", async () => {
  const { checkSourceCoverage, writeTypeScriptRoster } = await import(helper)
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 12 }),
    fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
    fc.boolean(),
    async (count, native, companions) => scratch(async root => {
      const manifest = []
      for (let index = 0; index < count; index++) {
        const id = "src/deep/module" + index + ".ts"
        manifest.push(id)
        if (native[index % native.length]) {
          const path = id.replace(/\.ts$/, ".vibe")
          write(root, path)
          if (companions) {
            write(root, path.replace(/\.vibe$/, ".d.vibe.ts"), "export declare const value: number\n")
            write(root, path + ".platform.d.ts", "export declare const platform: number\n")
          }
        } else write(root, id)
      }
      manifest.sort()
      const before = checkSourceCoverage(root, manifest)
      const after = writeTypeScriptRoster(root, manifest)
      assert.deepEqual(after.logical, manifest)
      assert.deepEqual(after.logical, before.logical)
      assert.deepEqual(JSON.parse(readFileSync(join(root, "coverage-roster.json"), "utf8")), after.typescript)
      assert.equal(after.logical.length, count)
      assert.equal(after.native.length + after.typescript.length - after.companions.length, count)
    })
  ), { numRuns: 96, examples: [[2, [true, false], true], [1, [true], false]] })
})

test("missing, extra and duplicate sources cannot be hidden by regeneration", async () => {
  const { writeTypeScriptRoster } = await import(helper)
  await scratch(async root => {
    write(root, "src/branch.vibe")
    write(root, "src/view.tsx")
    writeTypeScriptRoster(root, corpus.witness)
    const before = readFileSync(join(root, "coverage-roster.json"))
    unlinkSync(join(root, "src/branch.vibe"))
    assert.throws(() => writeTypeScriptRoster(root, corpus.witness), /missing/)
    assert.deepEqual(readFileSync(join(root, "coverage-roster.json")), before)
    write(root, "src/branch.vibe")
    write(root, "src/branch.ts")
    assert.throws(() => writeTypeScriptRoster(root, corpus.witness), /duplicate/)
    unlinkSync(join(root, "src/branch.ts"))
    write(root, "src/unregistered.vibe")
    assert.throws(() => writeTypeScriptRoster(root, corpus.witness), /extra/)
  })
})

test("unowned declaration files remain visible and malformed manifests are rejected", async () => {
  const { checkSourceCoverage } = await import(helper)
  await scratch(async root => {
    write(root, "src/branch.d.vibe.ts")
    assert.throws(() => checkSourceCoverage(root, []), /extra/)
    assert.throws(() => checkSourceCoverage(root, ["src/branch.ts", "src/branch.ts"]), /sorted, unique/)
    assert.throws(() => checkSourceCoverage(root, [null]), /sorted, unique/)
  })
})
