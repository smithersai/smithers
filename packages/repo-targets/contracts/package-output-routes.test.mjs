/**
 * Published package branches contain compiled imports and no private routes.
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import * as BuildLibrary from "../scripts/build-library.mjs"

const require = createRequire(import.meta.url)
const fc = require("fast-check")
const corpus = JSON.parse(readFileSync(new URL("./corpus/smithers-emitted-routes.json", import.meta.url), "utf8"))
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const route = {
  types: "./.vibe/declarations/src/user.d.vibe.ts",
  "vibelang-source": "./src/user.vibe",
  default: "./.vibelang/js/src/user.js"
}

const temporary = (body) => {
  const root = mkdtempSync(join(tmpdir(), "package-output-fixture-"))
  try { body(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

// A loader record proves a compile in this workspace and nowhere else. Sidecar
// generation writes one beside every published .vibelang/js directory.
const manifests = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (entry.name === "node_modules" || entry.name === "dist" || (entry.name.startsWith(".") && entry.name !== ".smithers")) return []
  const path = join(directory, entry.name)
  return entry.isDirectory() ? manifests(path) : entry.name === "package.json" ? [path] : []
})

test("no published package carries its loader records", () => {
  const repository = new URL("../../../", import.meta.url).pathname
  const published = manifests(repository)
    .map(path => [path, JSON.parse(readFileSync(path, "utf8")).files])
    .filter(([, files]) => files?.includes(".vibelang/js"))
  assert.ok(published.length > 0)
  for (const [path, files] of published) assert.ok(files.includes("!.vibelang/js/.loader"), path)
})

test("private routes are absent from a CommonJS map that also has ordinary imports", () => temporary(root => {
  write(join(root, "package.json"), JSON.stringify({ imports: {
    "#vibelang/emitted/src/user": route,
    "#local": { types: "./src/local.ts", default: "./src/local.ts" }
  } }))
  write(join(root, "dist/esm/index.d.ts"), "export {}\n")
  BuildLibrary.copyCommonJsDeclarations(root)
  assert.deepEqual(JSON.parse(readFileSync(join(root, "dist/cjs/package.json"), "utf8")), {
    type: "commonjs", imports: { "#local": { types: "./local.d.ts", default: "./local.js" } }
  })
}))

test("a CommonJS map containing only private routes is omitted", () => temporary(root => {
  write(join(root, "package.json"), JSON.stringify({ imports: { "#vibelang/emitted/src/user": route } }))
  write(join(root, "dist/esm/index.d.ts"), "export {}\n")
  BuildLibrary.copyCommonJsDeclarations(root)
  assert.deepEqual(JSON.parse(readFileSync(join(root, "dist/cjs/package.json"), "utf8")), { type: "commonjs" })
}))

test("published route references are diagnosed in JavaScript and declarations, with source maps excluded", () => temporary(root => {
  write(join(root, "dist/esm/Flow/index.d.ts"), 'export * from "#vibelang/emitted/src/Flow/Encoded";\n')
  write(join(root, "dist/cjs/index.js"), 'module.exports = require("#vibelang/emitted/src/user")\n')
  write(join(root, "dist/esm/user.js.map"), JSON.stringify({ sources: ["#vibelang/emitted/src/user"] }))
  assert.throws(() => BuildLibrary.assertNoEmittedRoutes(root),
    /published output names a private #vibelang\/emitted\/ route: dist\/cjs\/index\.js, dist\/esm\/Flow\/index\.d\.ts\./)
}))

test("relative emitted imports and an absent output directory are accepted", () => temporary(root => {
  assert.doesNotThrow(() => BuildLibrary.assertNoEmittedRoutes(root))
  write(join(root, "dist/esm/Flow/index.d.ts"), 'export * from "./Encoded.js";\n')
  write(join(root, "dist/cjs/Flow/index.js"), 'module.exports = require("./Encoded.js")\n')
  assert.doesNotThrow(() => BuildLibrary.assertNoEmittedRoutes(root))
}))

test("private routes are removed without losing ordinary package imports", () => {
  fc.assert(fc.property(
    fc.array(fc.record({
      stem: fc.constantFrom(...corpus.paths),
      extension: fc.constantFrom(...corpus.extensions),
      leak: fc.boolean()
    }), { minLength: 1, maxLength: 12 }),
    (entries) => {
      const root = mkdtempSync(join(tmpdir(), "package-output-routes-"))
      try {
        const imports = {}
        const expectedImports = {}
        const leaked = []
        for (const [index, entry] of entries.entries()) {
          const stem = entry.stem + index
          imports["#vibelang/emitted/" + stem] = { ...route }
          imports["#local/" + stem] = { types: "./src/" + stem + ".ts", default: "./src/" + stem + ".ts" }
          expectedImports["#local/" + stem] = { types: "./" + stem + ".d.ts", default: "./" + stem + ".js" }
          const path = "dist/" + (index % 2 === 0 ? "esm/" : "cjs/") + stem + entry.extension
          write(join(root, path), entry.leak
            ? "export * from \"#vibelang/emitted/" + stem + "\";\n"
            : "export * from \"./Sibling.js\";\n")
          write(join(root, path + ".map"), JSON.stringify({ sources: ["#vibelang/emitted/" + stem] }))
          if (entry.leak) leaked.push(path)
        }
        write(join(root, "dist/esm/index.d.ts"), "export {}\n")
        write(join(root, "package.json"), JSON.stringify({ type: "module", imports }))
        BuildLibrary.copyCommonJsDeclarations(root)
        assert.deepEqual(JSON.parse(readFileSync(join(root, "dist/cjs/package.json"), "utf8")), { type: "commonjs", imports: expectedImports })
        if (leaked.length === 0) {
          assert.doesNotThrow(() => BuildLibrary.assertNoEmittedRoutes(root))
        } else {
          assert.throws(() => BuildLibrary.assertNoEmittedRoutes(root), error => {
            const diagnostic = String(error)
            assert.match(diagnostic, /published output names a private/)
            for (const path of leaked) assert.ok(diagnostic.includes(path), path)
            assert.ok(!diagnostic.includes(".map"))
            return true
          })
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  ), { numRuns: 96 })
})
