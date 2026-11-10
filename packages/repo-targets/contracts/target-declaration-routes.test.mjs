import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { createRequire } from "node:module"
import { test } from "node:test"
import { checkLoaderRecord } from "vibelang/project"
import { prepareSidecars, sidecarProjects } from "../scripts/prepare-sidecars.mjs"
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
  assert.equal(selected.length, 7)
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


test("native declarations bootstrap a clean project without weakening its full check", () => fixture(dir => {
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "declaration-bootstrap-fixture", type: "module" }))
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    vibe: { sidecarDir: ".vibe/declarations" },
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      skipLibCheck: true, noEmit: true, rootDir: "src", rootDirs: [".", ".vibe/declarations"],
      types: ["node"], allowArbitraryExtensions: true
    },
    include: ["src/**/*"]
  }))
  writeFileSync(join(dir, "src/ambient.d.ts"), "declare const ApplicationTokenBrand: unique symbol\n")
  mkdirSync(join(dir, "dependencies"))
  writeFileSync(join(dir, "dependencies/global.d.ts"),
    "declare global { namespace AmbientDependency { type Token = string } }\nexport {}\n")
  writeFileSync(join(dir, "src/context.ts"),
    '/// <reference lib="es2024" />\nimport type {} from "../dependencies/global.js"\n')
  writeFileSync(join(dir, "src/value.vibe"),
    'export type Brand = typeof ApplicationTokenBrand\nexport type Token = AmbientDependency.Token\nexport effect function value() { return "ok".isWellFormed() ? 42 : 0 }\n')
  writeFileSync(join(dir, "src/unrelated.ts"), 'export const broken: number = "wrong"\n')
  const declaration = join(dir, ".vibe/declarations/src/value.d.vibe.ts")
  assert.equal(existsSync(declaration), false)
  const projects = sidecarProjects(dir)
  assert.equal(projects.length, 1)
  assert.ok(projects[0].files.includes(join(dir, "src/ambient.d.ts")))
  assert.ok(!projects[0].files.includes(join(dir, "src/unrelated.ts")))
  assert.ok(projects[0].files.includes(join(dir, "dependencies/global.d.ts")))
  assert.ok(projects[0].libs.includes("es2024.string"))
  assert.equal(prepareSidecars(dir, { stdio: "pipe" }), 1)
  assert.match(readFileSync(declaration, "utf8"), /value/)
  assert.equal(checkLoaderRecord({ project: join(dir, "tsconfig.json") }).miss, undefined, "a cold start must find a current loader record")
  writeFileSync(join(dir, "src/value.vibe"), readFileSync(join(dir, "src/value.vibe"), "utf8") + "export const later = 1\n")
  assert.notEqual(checkLoaderRecord({ project: join(dir, "tsconfig.json") }).miss, undefined, "an edit must invalidate the record")
  writeFileSync(join(dir, "src/value.vibe"), readFileSync(join(dir, "src/value.vibe"), "utf8").replace("export const later = 1\n", ""))
  const read = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir)
  const found = ts.resolveModuleName("./value.vibe", join(dir, "src/consumer.ts"), parsed.options, ts.sys).resolvedModule
  assert.equal(found?.resolvedFileName, declaration)
  const compiler = join(dirname(require.resolve("vibelang/package.json")), "bin/vibelang")
  const full = spawnSync(process.execPath, [compiler, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" })
  assert.notEqual(full.status, 0, "the ordinary project check must still reject unrelated TypeScript errors")
  assert.match(full.stdout + full.stderr, /TS2322/)
  writeFileSync(join(dir, "src/value.vibe"), 'export const value: number = "wrong"\n')
  assert.throws(() => prepareSidecars(dir, { stdio: "pipe" }), /TS2322/)
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith(".tsconfig.vibelang-sidecars-")), [])
}))

test("declaration preparation preserves project scope and inherited conditions across nested roots", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom("nested", "workspace", "source"), { maxLength: 4 }),
    fc.array(fc.constantFrom("application-source", "browser-source", "vibelang-source"), { maxLength: 4 }),
    (segments, conditions) => fixture(dir => {
      const home = join(dir, ...segments, "package")
      mkdirSync(join(home, "src"), { recursive: true })
      mkdirSync(join(home, "test/fixtures"), { recursive: true })
      const base = join(dir, "base.json")
      writeFileSync(base, JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", customConditions: conditions }
      }))
      writeFileSync(join(home, "tsconfig.json"), JSON.stringify({
        extends: relative(home, base), include: ["src/**/*", "test/**/*"]
      }))
      writeFileSync(join(home, "src/value.vibe"), "export const value = 1\n")
      writeFileSync(join(home, "test/fixtures/broken.vibe"), "not valid VibeLang\n")
      const [project] = sidecarProjects(dir)
      assert.deepEqual(project.files, [join(home, "src/value.vibe")])
      assert.deepEqual(project.conditions, [...new Set([...conditions, "vibelang-source"])])
    })
  ), { numRuns: 64, seed: 51720 })
})

test("sidecars land where rootDirs pairs them when every native source sits under src", () => fixture(dir => {
  // No rootDir: the generation project lists only native files, so a compiler that computes the
  // source root from them would choose src and write .vibe/declarations/value.d.vibe.ts, which
  // rootDirs [".", ".vibe/declarations"] never pairs with src/value.vibe.
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "declaration-root-fixture", type: "module" }))
  mkdirSync(join(dir, "src/internal"), { recursive: true })
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    vibe: { sidecarDir: ".vibe/declarations" },
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      skipLibCheck: true, noEmit: true, rootDirs: [".", ".vibe/declarations"], allowArbitraryExtensions: true
    },
    include: ["src/**/*", "test/**/*"]
  }))
  writeFileSync(join(dir, "src/value.vibe"), "export const value = 1\n")
  writeFileSync(join(dir, "src/internal/depth.vibe"), "export const depth = 2\n")
  const [project] = sidecarProjects(dir)
  assert.equal(project.rootDir, dir)
  assert.equal(prepareSidecars(dir, { stdio: "pipe" }), 1)
  for (const name of ["value", "internal/depth"]) {
    const declaration = join(dir, ".vibe/declarations/src/" + name + ".d.vibe.ts")
    assert.ok(existsSync(declaration), declaration)
  }
  assert.equal(existsSync(join(dir, ".vibe/declarations/value.d.vibe.ts")), false)
  const read = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir)
  const found = ts.resolveModuleName("./value.vibe", join(dir, "src/consumer.ts"), parsed.options, ts.sys).resolvedModule
  assert.equal(found?.resolvedFileName, join(dir, ".vibe/declarations/src/value.d.vibe.ts"))
}))

test("sidecars stay paired when a project's program reaches another package's native sources", () => fixture(dir => {
  // The program for app reaches lib's source, so the compiler's common directory is the
  // workspace root and it writes app/.vibe/declarations/app/src/main.d.vibe.ts plus lib's
  // sidecar. Generation must leave app's sidecar where rootDirs pairs it and nothing of lib's.
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "declaration-reach-fixture", type: "module" }))
  const project = name => {
    mkdirSync(join(dir, name, "src/same"), { recursive: true })
    writeFileSync(join(dir, name, "tsconfig.json"), JSON.stringify({
      vibe: { sidecarDir: ".vibe/declarations" },
      compilerOptions: {
        target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
        skipLibCheck: true, noEmit: true, rootDirs: [".", ".vibe/declarations"], allowArbitraryExtensions: true
      },
      include: ["src/**/*"]
    }))
  }
  project("lib")
  project("app")
  writeFileSync(join(dir, "lib/src/value.vibe"), "export const value = 1\n")
  writeFileSync(join(dir, "app/src/main.vibe"), 'import { value } from "../../lib/src/value.vibe"\nexport const main = value + 1\n')
  writeFileSync(join(dir, "app/src/same/main.vibe"), "export const nested = 2\n")
  writeFileSync(join(dir, "app/src/same/helper.ts"), "export type Helper = { readonly n: number }\n")
  writeFileSync(join(dir, "app/src/same/uses.vibe"), 'import type { Helper } from "./helper.ts"\nexport const make = (n: number): Helper => ({ n })\n')
  assert.equal(prepareSidecars(dir, { stdio: "pipe" }), 2)
  // The sidecar names helper.ts by a relative path; after the move it still reaches the real file.
  const uses = join(dir, "app/.vibe/declarations/src/same/uses.d.vibe.ts")
  const specifiers = [...readFileSync(uses, "utf8").matchAll(/from "(\.[^"]+)"/g)].map(match => match[1])
  assert.ok(specifiers.length > 0, readFileSync(uses, "utf8"))
  for (const specifier of specifiers) {
    if (specifier.endsWith(".ts")) assert.ok(existsSync(resolve(dirname(uses), specifier)), specifier)
  }
  const listed = name => readdirSync(join(dir, name, ".vibe/declarations"), { recursive: true })
    .filter(file => file.endsWith(".d.vibe.ts")).map(file => file.split("\\").join("/")).sort()
  assert.deepEqual(listed("app"), ["src/main.d.vibe.ts", "src/same/main.d.vibe.ts", "src/same/uses.d.vibe.ts"])
  assert.deepEqual(listed("lib"), ["src/value.d.vibe.ts"])
  assert.match(readFileSync(join(dir, "app/.vibe/declarations/src/same/main.d.vibe.ts"), "utf8"), /nested/)
}))

test("a package's published src/test helpers get sidecars; its own test directory does not", () => fixture(dir => {
  // An export map names .vibe/declarations/src/test/TestJournal.d.vibe.ts for @smthrs/journal/test/TestJournal,
  // so a consumer without the vibelang-source condition needs that sidecar to exist.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test-helper-fixture", type: "module" }))
  mkdirSync(join(dir, "src/test"), { recursive: true })
  mkdirSync(join(dir, "test"), { recursive: true })
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    vibe: { sidecarDir: ".vibe/declarations" },
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true },
    include: ["src/**/*", "test/**/*"]
  }))
  writeFileSync(join(dir, "src/value.vibe"), "export const value = 1\n")
  writeFileSync(join(dir, "src/test/helper.vibe"), "export const helper = 2\n")
  writeFileSync(join(dir, "test/support.vibe"), "export const support = 3\n")
  const [project] = sidecarProjects(dir)
  assert.deepEqual(project.native.map(file => relative(dir, file)), ["src/test/helper.vibe", "src/value.vibe"])
}))

test("a project that fails generation does not cost the others their loader records", () => fixture(dir => {
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir")
  for (const name of ["good", "bad"]) {
    mkdirSync(join(dir, name, "src"), { recursive: true })
    writeFileSync(join(dir, name, "package.json"), JSON.stringify({ name: "records-" + name, type: "module" }))
    writeFileSync(join(dir, name, "tsconfig.json"), JSON.stringify({
      vibe: { sidecarDir: ".vibe/declarations" },
      compilerOptions: {
        target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
        skipLibCheck: true, noEmit: true, rootDir: "src", rootDirs: [".", ".vibe/declarations"], allowArbitraryExtensions: true
      },
      include: ["src/**/*"]
    }))
  }
  writeFileSync(join(dir, "good/src/value.vibe"), "export const value = 1\n")
  writeFileSync(join(dir, "bad/src/value.vibe"), 'export const value: number = "wrong"\n')
  assert.throws(() => prepareSidecars(dir, { stdio: "pipe" }), /bad\/tsconfig\.json: declaration generation failed/)
  assert.equal(checkLoaderRecord({ project: join(dir, "good/tsconfig.json") }).miss, undefined, "the generated project keeps its record")
  assert.notEqual(checkLoaderRecord({ project: join(dir, "bad/tsconfig.json") }).miss, undefined)
}))
