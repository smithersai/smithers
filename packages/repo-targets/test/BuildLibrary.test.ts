import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, expect, it } from "vitest"
import {
  buildLibrary,
  copyCommonJsDeclarations,
  copyInputDeclarations,
  packageCompiler,
  vibeSourcePackages
} from "../scripts/build-library.mjs"

const roots: Array<string> = []
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "repo-targets-build-library-"))
  roots.push(root)
  return root
}
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const read = (path: string) => readFileSync(path, "utf8")

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it("copies only hand-written declarations, keeping their nested paths", () => {
  const root = scratch()
  write(join(root, "src/index.ts"), "export {}\n")
  write(join(root, "src/ambient.d.ts"), "declare const top: 1\n")
  write(join(root, "src/deep/er/shape.d.ts"), "export type Shape = 1\n")
  write(join(root, "src/deep/er/shape.d.ts.map"), "{}\n")
  copyInputDeclarations(join(root, "src"), join(root, "dist/esm"))
  expect(read(join(root, "dist/esm/ambient.d.ts"))).toBe("declare const top: 1\n")
  expect(read(join(root, "dist/esm/deep/er/shape.d.ts"))).toBe("export type Shape = 1\n")
  expect(existsSync(join(root, "dist/esm/index.ts"))).toBe(false)
  expect(existsSync(join(root, "dist/esm/deep/er/shape.d.ts.map"))).toBe(false)
})

it("mirrors ESM declarations and maps into the CommonJS branch and marks it CommonJS", () => {
  const root = scratch()
  write(join(root, "dist/esm/index.js"), "export {}\n")
  write(join(root, "dist/esm/index.d.ts"), "export {}\n")
  write(join(root, "dist/esm/nested/a.d.ts"), "export declare const a: 1\n")
  write(join(root, "dist/esm/nested/a.d.ts.map"), "{\"sources\":[\"../../../src/nested/a.ts\"]}\n")
  copyCommonJsDeclarations(root)
  expect(read(join(root, "dist/cjs/index.d.ts"))).toBe("export {}\n")
  expect(read(join(root, "dist/cjs/nested/a.d.ts"))).toBe("export declare const a: 1\n")
  expect(read(join(root, "dist/cjs/nested/a.d.ts.map"))).toBe("{\"sources\":[\"../../../src/nested/a.ts\"]}\n")
  expect(existsSync(join(root, "dist/cjs/index.js"))).toBe(false)
  expect(JSON.parse(read(join(root, "dist/cjs/package.json")))).toEqual({ type: "commonjs" })
})

it("keeps package imports resolvable inside the CommonJS package boundary", () => {
  const root = scratch()
  mkdirSync(join(root, "node_modules"))
  symlinkSync(
    dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
    join(root, "node_modules/typescript"),
    "dir"
  )
  write(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      imports: {
        "#external": { types: "./src/compiler.d.ts", default: "typescript" },
        "#local": { types: "./src/local.ts", default: "./src/local.ts" },
        "#compiled": "./dist/cjs/local.js",
        "#deep/*": "./src/deep/*.ts",
        "#fallback": [null, "typescript"],
        "#blocked": null
      }
    })
  )
  write(join(root, "dist/esm/compiler.d.ts"), "export declare const version: string\n")
  write(join(root, "dist/esm/local.d.ts"), "export declare const value: 42\n")
  write(join(root, "dist/cjs/local.js"), "exports.value = 42\n")
  write(join(root, "dist/cjs/deep/value.js"), "exports.value = 43\n")
  write(join(root, "dist/cjs/index.js"), "exports.value = require(\"#external\").version\n")
  copyCommonJsDeclarations(root)
  const require = createRequire(join(root, "dist/cjs/index.js"))
  expect(require("./index.js").value).toMatch(/^\d+\.\d+\.\d+/)
  expect(require("#local").value).toBe(42)
  expect(require("#compiled").value).toBe(42)
  expect(require("#deep/value").value).toBe(43)
  expect(() => require("#blocked")).toThrow(/not defined/)
  expect(JSON.parse(read(join(root, "dist/cjs/package.json")))).toEqual({
    type: "commonjs",
    imports: {
      "#external": { types: "./compiler.d.ts", default: "typescript" },
      "#local": { types: "./local.d.ts", default: "./local.js" },
      "#compiled": "./local.js",
      "#deep/*": "./deep/*.js",
      "#fallback": [null, "typescript"],
      "#blocked": null
    }
  })
  expect(read(join(root, "dist/cjs/compiler.d.ts"))).toContain("version")
})

it("refuses import-map targets the CommonJS branch cannot preserve", () => {
  const root = scratch()
  write(join(root, "package.json"), JSON.stringify({ imports: { "#asset": "./assets/value.js" } }))
  write(join(root, "dist/esm/index.d.ts"), "export {}\n")
  expect(() => copyCommonJsDeclarations(root)).toThrow(/CommonJS import target.*assets\/value\.js/)
})

// The fixture links the workspace's own esbuild and typescript into its
// node_modules, because buildLibrary resolves both from the package it builds.
const fixture = () => {
  const root = scratch()
  const require = createRequire(import.meta.url)
  for (const name of ["esbuild", "typescript"]) {
    mkdirSync(join(root, "node_modules"), { recursive: true })
    symlinkSync(dirname(require.resolve(`${name}/package.json`)), join(root, "node_modules", name), "dir")
  }
  write(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }))
  write(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
        outDir: "dist/esm",
        rootDir: "src",
        skipLibCheck: true
      },
      include: ["src"]
    })
  )
  write(
    join(root, "src/index.ts"),
    [
      "export * from \"./lib/value.ts\"",
      "export const later = () => import(\"./lib/value.ts\")",
      "export const load = (specifier: string) => import(specifier)",
      ""
    ].join("\n")
  )
  write(join(root, "src/lib/value.ts"), "export const value = \"pkg/value.ts\"\n")
  write(join(root, "src/esm-only.ts"), "export const top = await Promise.resolve(1)\n")
  write(join(root, "src/types.d.ts"), "export type Hand = 1\n")
  return root
}

it("builds a CommonJS branch whose relative requires load the emitted .js files", async () => {
  const root = fixture()
  await buildLibrary(root, { esmOnly: ["esm-only.ts"] })
  const index = read(join(root, "dist/cjs/index.js"))
  expect(index).toContain("Promise.resolve().then(() => require(\"./lib/value.js\"))")
  expect(index).not.toMatch(/\.\/lib\/value\.ts/)
  // A computed specifier stays a native import(): require() cannot load a file URL.
  expect(index).toContain("import(specifier)")
  // A string literal that only looks like a module path stays untouched.
  expect(read(join(root, "dist/cjs/lib/value.js"))).toContain("\"pkg/value.ts\"")
  expect(existsSync(join(root, "dist/cjs/esm-only.js"))).toBe(false)
  expect(read(join(root, "dist/esm/types.d.ts"))).toBe("export type Hand = 1\n")
  expect(read(join(root, "dist/cjs/types.d.ts"))).toBe("export type Hand = 1\n")
  expect(existsSync(join(root, "dist/cjs/lib/value.d.ts"))).toBe(true)
  const browser = await createRequire(import.meta.url)("esbuild").build({
    entryPoints: [join(root, "dist/cjs/index.js")],
    bundle: true,
    platform: "browser",
    write: false,
    logLevel: "silent"
  })
  expect(browser.errors).toEqual([])
  const loaded = createRequire(join(root, "dist/cjs/index.js"))("./index.js")
  expect(loaded.value).toBe("pkg/value.ts")
  expect((await loaded.later()).value).toBe("pkg/value.ts")
  write(join(root, "outside.mjs"), "export const named = \"esm\"\n")
  expect((await loaded.load(pathToFileURL(join(root, "outside.mjs")).href)).named).toBe("esm")
})

it("preserves module-relative import.meta values for native CommonJS hosts", async () => {
  const root = fixture()
  const config = JSON.parse(read(join(root, "tsconfig.json")))
  config.compilerOptions.emitDeclarationOnly = false
  config.compilerOptions.alwaysStrict = false
  write(join(root, "tsconfig.json"), JSON.stringify(config))
  mkdirSync(join(root, "node_modules/@types"), { recursive: true })
  symlinkSync(
    dirname(createRequire(import.meta.url).resolve("@types/node/package.json")),
    join(root, "node_modules/@types/node"),
    "dir"
  )
  write(
    join(root, "src/nested space/location.ts"),
    [
      "export const url = import.meta.url",
      "export const directory = import.meta.dirname",
      "export const resolved = import.meta.resolve(\"../lib/value.js\")",
      "export function receiver(this: void) { return this }",
      ""
    ].join("\n")
  )
  await buildLibrary(root, { esmOnly: ["esm-only.ts"], commonJsPlatform: "node" })
  const commonjs = createRequire(join(root, "dist/cjs/index.js"))("./nested space/location.js")
  expect(commonjs.url).toBe(pathToFileURL(join(root, "dist/cjs/nested space/location.js")).href)
  expect(commonjs.directory).toBe(join(root, "dist/cjs/nested space"))
  expect(commonjs.resolved).toBe(pathToFileURL(join(root, "dist/cjs/lib/value.js")).href)
  const commonjsReceiver = commonjs.receiver
  expect(commonjsReceiver() === undefined).toBe(true)
  const esm = await import(pathToFileURL(join(root, "dist/esm/nested space/location.js")).href)
  expect(esm.url).toBe(pathToFileURL(join(root, "dist/esm/nested space/location.js")).href)
  expect(esm.directory).toBe(join(root, "dist/esm/nested space"))
  expect(esm.resolved).toBe(pathToFileURL(join(root, "dist/esm/lib/value.js")).href)
  const esmReceiver = esm.receiver
  expect(esmReceiver() === undefined).toBe(true)
})

it("removes a stale dist and reports a failing declaration compile", async () => {
  const root = fixture()
  write(join(root, "dist/stale.txt"), "old\n")
  write(join(root, "src/broken.ts"), "export const broken: number = \"no\"\n")
  await expect(buildLibrary(root, { esmOnly: ["esm-only.ts"] })).rejects.toThrow(/^package compiler exited 2$/)
  expect(existsSync(join(root, "dist/stale.txt"))).toBe(false)
})

// A VibeLang package: an `error` declaration and an Effect function, which
// compile to code that imports vibelang-runtime and effect.
const tools = ["esbuild", "typescript", "vibelang", "effect", "vibelang-runtime"]
// vibelang-runtime exports no ./package.json, so its directory is found from its entry.
const packageDirectory = (name: string) => {
  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve(`${name}/package.json`))
  } catch {
    let directory = dirname(require.resolve(name))
    while (!existsSync(join(directory, "package.json")) || JSON.parse(read(join(directory, "package.json"))).name !== name) {
      directory = dirname(directory)
    }
    return directory
  }
}
const link = (root: string) => {
  mkdirSync(join(root, "node_modules"), { recursive: true })
  for (const name of tools) symlinkSync(packageDirectory(name), join(root, "node_modules", name), "dir")
}
const tsconfig = JSON.stringify({
  compilerOptions: {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    target: "ES2022",
    strict: true,
    declaration: true,
    declarationMap: true,
    sourceMap: true,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    outDir: "dist/esm",
    rootDir: "src",
    skipLibCheck: true
  },
  include: ["src"]
})
const vibePackage = (root: string, name: string) => {
  link(root)
  write(join(root, "package.json"), JSON.stringify({ name, type: "module", exports: { ".": "./src/index.ts" } }))
  write(join(root, "tsconfig.json"), tsconfig)
  write(
    join(root, "src/Lookup.vibe"),
    [
      "export error Missing { key: string }",
      "",
      "export function lookup(key: string): Effect<string, Missing> {",
      "  if (key === \"\") throw new Missing({ key })",
      "  return key.toUpperCase()",
      "}",
      ""
    ].join("\n")
  )
  write(join(root, "src/index.ts"), "export { lookup, Missing } from \"./Lookup.vibe\"\n")
  return root
}

it("builds a VibeLang package's ESM, declarations, maps and CommonJS with vibelang", async () => {
  const root = vibePackage(scratch(), "vibe-fixture")
  expect(packageCompiler(root).name).toBe("vibelang")
  await buildLibrary(root)
  for (const file of ["Lookup.js", "Lookup.js.map", "Lookup.d.ts", "Lookup.d.ts.map", "index.js", "index.d.ts"]) {
    expect(existsSync(join(root, "dist/esm", file)), `dist/esm/${file}`).toBe(true)
    expect(existsSync(join(root, "dist/cjs", file)), `dist/cjs/${file}`).toBe(true)
  }
  expect(read(join(root, "dist/esm/index.js"))).toContain("from \"./Lookup.js\"")
  expect(read(join(root, "dist/esm/Lookup.d.ts"))).toContain("export declare function lookup(key: string)")
  // Both branches map back to the .vibe source, CommonJS through the ESM it was built from.
  expect(JSON.parse(read(join(root, "dist/esm/Lookup.js.map"))).sources).toEqual(["../../src/Lookup.vibe"])
  expect(JSON.parse(read(join(root, "dist/cjs/Lookup.js.map"))).sources).toEqual(["../../src/Lookup.vibe"])
  const cjs = read(join(root, "dist/cjs/Lookup.js"))
  expect(cjs).toContain("require(\"vibelang-runtime\")")
  expect(cjs).not.toMatch(/\.vibe["']/)
  const { Effect } = await import("effect")
  const loaded = createRequire(join(root, "dist/cjs/index.js"))("./index.js")
  expect(Effect.runSync(loaded.lookup("ok"))).toBe("OK")
  const esm: { readonly lookup: (key: string) => import("effect").Effect.Effect<string, { readonly _tag: string }> } =
    await import(pathToFileURL(join(root, "dist/esm/index.js")).href)
  expect(Effect.runSync(Effect.flip(esm.lookup("")))._tag).toBe("Missing")
})

it("compiles a TypeScript package with vibelang when a linked dependency has VibeLang sources", async () => {
  const workspace = scratch()
  const dependency = vibePackage(join(workspace, "dependency"), "vibe-dependency")
  const root = join(workspace, "consumer")
  link(root)
  symlinkSync(dependency, join(root, "node_modules", "vibe-dependency"), "dir")
  write(
    join(root, "package.json"),
    JSON.stringify({ name: "consumer", type: "module", dependencies: { "vibe-dependency": "workspace:*" } })
  )
  write(join(root, "tsconfig.json"), tsconfig)
  write(
    join(root, "src/index.ts"),
    "import { lookup } from \"vibe-dependency\"\nexport const shout = (key: string) => lookup(key)\n"
  )
  expect(vibeSourcePackages(root)).toEqual([{ name: "vibe-dependency", root: realpathSync(dependency) }])
  expect(packageCompiler(root).name).toBe("vibelang")
  await buildLibrary(root)
  expect(read(join(root, "dist/esm/index.d.ts"))).toContain("Effect<string, ")
  // Its own sources are TypeScript, so its CommonJS still comes from them.
  expect(JSON.parse(read(join(root, "dist/cjs/index.js.map"))).sources).toEqual(["../../src/index.ts"])
})

it("keeps tsc for a package with no VibeLang in reach, and does not follow installed packages", () => {
  const workspace = scratch()
  const root = fixture()
  // An installed package ships JavaScript: .vibe files inside node_modules are not sources.
  const installed = join(root, "node_modules/installed")
  write(join(installed, "package.json"), JSON.stringify({ name: "installed" }))
  write(join(installed, "src/Stray.vibe"), "export const stray = 1\n")
  write(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module", dependencies: { installed: "1.0.0" } }))
  expect(vibeSourcePackages(root)).toEqual([])
  expect(packageCompiler(root).name).toBe("tsc")
  // A linked package's development dependencies are not followed.
  const dependency = vibePackage(join(workspace, "dev-only"), "dev-only")
  const middle = join(workspace, "middle")
  write(join(middle, "package.json"), JSON.stringify({ name: "middle", devDependencies: { "dev-only": "workspace:*" } }))
  mkdirSync(join(middle, "node_modules"), { recursive: true })
  symlinkSync(dependency, join(middle, "node_modules/dev-only"), "dir")
  symlinkSync(middle, join(root, "node_modules/middle"), "dir")
  write(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module", dependencies: { middle: "workspace:*" } }))
  expect(vibeSourcePackages(root)).toEqual([])
  expect(vibeSourcePackages(middle).map((entry) => entry.name)).toEqual(["dev-only"])
})

it("fails the build on a type error in a .vibe module", async () => {
  const root = vibePackage(scratch(), "vibe-broken")
  write(join(root, "src/Broken.vibe"), "export function count(): Effect<number> {\n  return \"none\"\n}\n")
  await expect(buildLibrary(root)).rejects.toThrow(/^package compiler exited 2$/)
  expect(existsSync(join(root, "dist/cjs"))).toBe(false)
})
