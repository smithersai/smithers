import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { test } from "node:test"
const require = createRequire(import.meta.url)
const ts = require("typescript")
const fc = require("fast-check")
const root = resolve(import.meta.dirname, "../../..")
const targets = join(root, "packages/smithers/build/targets")
const pkg = JSON.parse(readFileSync(join(targets, "package.json"), "utf8"))
const corpus = JSON.parse(readFileSync(new URL("./smithers-targets-declaration-root.json", import.meta.url), "utf8"))
const selected = corpus.exports.map(name => [name, pkg.exports[name]])
const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, strict: true }
const resolved = (name, file) => ts.resolveModuleName(name, file, options, ts.sys).resolvedModule
const fixture = action => {
  const dir = mkdtempSync(join(tmpdir(), "target-declaration-route-"))
  try { action(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
test("every migrated public target points at its physical declaration", () => {
  assert.equal(selected.length, 9)
  for (const [name, entry] of selected) {
    assert.equal(entry["vibelang-source"], "./src/" + name.slice(2) + ".vibe")
    assert.match(readFileSync(resolve(targets, entry.types), "utf8"), /export/)
  }
})
test("TypeScript resolves the real package exports to their declarations", () => fixture(dir => {
  mkdirSync(join(dir, "node_modules/@smthrs"), { recursive: true })
  symlinkSync(targets, join(dir, "node_modules/@smthrs/targets"), "dir")
  const consumer = join(dir, "consumer.ts")
  writeFileSync(consumer, "")
  for (const [name, entry] of selected) {
    const found = resolved("@smthrs/targets" + name.slice(1), consumer)
    assert.ok(found, name)
    assert.equal(found.resolvedFileName, resolve(targets, entry.types))
    assert.equal(found.extension, ts.Extension.Ts)
  }
}))
test("declaration conditions retain the source directory in nested package layouts", () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: selected.length - 1 }),
    fc.array(fc.constantFrom("nested", "generated", "package", "output"), { minLength: 0, maxLength: 4 }),
    (index, segments) => fixture(dir => {
      const [name, entry] = selected[index]
      const home = join(dir, "node_modules/@fixture/targets")
      const prefix = segments.length ? segments.join("/") + "/" : ""
      const expected = join(home, prefix + ".vibe/declarations/src/" + name.slice(2) + ".d.vibe.ts")
      const javascript = join(home, prefix + ".vibelang/js/src/" + name.slice(2) + ".js")
      mkdirSync(dirname(expected), { recursive: true })
      mkdirSync(dirname(javascript), { recursive: true })
      writeFileSync(expected, "export declare const witness: number\n")
      writeFileSync(javascript, "export const witness = 1\n")
      writeFileSync(join(home, "package.json"), JSON.stringify({
        name: "@fixture/targets", type: "module",
        exports: { [name]: { types: "./" + prefix + entry.types.slice(2), default: "./" + prefix + ".vibelang/js/src/" + name.slice(2) + ".js" } }
      }))
      const consumer = join(dir, "consumer.ts")
      writeFileSync(consumer, "")
      const found = resolved("@fixture/targets" + name.slice(1), consumer)
      assert.equal(found?.resolvedFileName, expected)
      assert.equal(found.extension, ts.Extension.Ts)
    })
  ), { numRuns: 64, seed: 51719 })
})
