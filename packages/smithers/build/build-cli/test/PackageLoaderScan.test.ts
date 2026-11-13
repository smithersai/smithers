/**
 * The static import scan in front of declaration evaluation: what the lexer
 * reads as an import, how a specifier's escapes decode, which files a
 * specifier may name, how imports by name are followed, and the factory and
 * cycle rules applied to the scanned closure. Every assertion reads the loaded
 * graph's `modules`, a typed `PackageError`, or the probe result.
 */
import * as Fs from "node:fs/promises"
import { createRequire, registerHooks } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const workspace = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`

const validPackage = `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {} })
`

const fixture = async (packageSource: string = validPackage): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-loader-scan-")))
  roots.push(root)
  await write(root, "WORKSPACE.ts", workspace)
  await write(root, "PACKAGE.ts", packageSource)
  return root
}

const loaded = async (root: string): Promise<PackageLoader.LoadedGraph> =>
  PackageLoader.load(await PackageDiscovery.discover(root))

/** Links `packages/<name>` into `node_modules/@fixture/<name>` as a workspace package. */
const workspacePackage = async (root: string, name: string, files: Record<string, string>): Promise<void> => {
  await write(
    root,
    `packages/${name}/package.json`,
    JSON.stringify({ name: `@fixture/${name}`, type: "module", exports: "./index.ts" })
  )
  for (const [file, text] of Object.entries(files)) await write(root, `packages/${name}/${file}`, text)
  await Fs.mkdir(NodePath.join(root, "node_modules/@fixture"), { recursive: true })
  await Fs.symlink(NodePath.join(root, "packages", name), NodePath.join(root, "node_modules/@fixture", name), "dir")
}

describe("PackageLoader import lexer", () => {
  it.each([
    ["a line comment that ends the file", `${validPackage}// import "./WORKSPACE.js"`],
    [
      "an escaped backtick inside a template",
      `${validPackage}export const t = \`a\\\` import "./WORKSPACE.js" \\\`\`\n`
    ],
    ["a slash inside a regex character class", `${validPackage}export const r = /[/]import "..\\/outside.ts"/\n`],
    [
      "a regex after the return keyword",
      `${validPackage}export const f = () => {\n  return /import "..\\/outside.ts"/\n}\n`
    ]
  ])("records no import for %s", async (_name, source) => {
    const graph = await loaded(await fixture(source))
    expect(graph.packages.map((row) => row.file)).toEqual(["PACKAGE.ts"])
    expect(graph.modules).toEqual(["PACKAGE.ts", "WORKSPACE.ts"])
  })

  it.each([
    ["a division after a number", `export const half = 4 / 2; import "./WORKSPACE.js"\n${validPackage}`],
    ["a slash misread as a regex", `let n = 1\nexport const q = n++ / 2\nimport "./WORKSPACE.js"\n${validPackage}`],
    ["an unterminated string", `export const s = "open\nimport "./WORKSPACE.js"\n${validPackage}`]
  ])("resumes scanning after %s and still sees the next import", async (_name, source) => {
    await expect(loaded(await fixture(source))).rejects.toMatchObject({
      code: "unsupported_module_specifier",
      path: "PACKAGE.ts"
    })
  })

  it("leaves an unterminated block comment to the evaluator", async () => {
    await expect(loaded(await fixture(`${validPackage}/* import "./WORKSPACE.js"`))).rejects.toMatchObject({
      code: "module_import_failed"
    })
  })
})

describe("PackageLoader specifier decoding", () => {
  it.each([
    ["a backslash-CRLF continuation", "./help\\\r\ner.ts"],
    ["a backslash-CR continuation", "./help\\\rer.ts"]
  ])("follows a helper named through %s", async (_name, specifier) => {
    const root = await fixture(`import type { Value } from "${specifier}"\n${validPackage}`)
    await write(root, "helper.ts", "export type Value = string\n")
    expect((await loaded(root)).modules).toEqual(["PACKAGE.ts", "WORKSPACE.ts", "helper.ts"])
  })

  it("decodes a single-character escape into the file name", async () => {
    const root = await fixture(`import type { Value } from "./tab\\there.ts"\n${validPackage}`)
    await write(root, "tab\there.ts", "export type Value = string\n")
    expect((await loaded(root)).modules).toEqual(["PACKAGE.ts", "WORKSPACE.ts", "tab\there.ts"])
  })

  it.each(["\\0virtual", "virtual\\0"])("records nothing for the NUL-bearing named specifier %s", async (specifier) => {
    const root = await fixture(`import type { Value } from "${specifier}"\n${validPackage}`)
    expect((await loaded(root)).modules).toEqual(["PACKAGE.ts", "WORKSPACE.ts"])
  })

  it.each([
    ["legacy octal", "../outside\\01.ts"],
    ["non-zero digit", "../outside\\1.ts"],
    ["short hex", "../outside\\xZ1.ts"],
    ["unclosed code point", "../outside\\u{6f"],
    ["empty code point", "../outside\\u{}.ts"],
    ["code point above U+10FFFF", "../outside\\u{110000}.ts"],
    ["short unicode", "../outside\\u00Z1.ts"]
  ])("leaves a %s escape to the evaluator instead of guessing a path", async (_name, specifier) => {
    const root = await fixture(`import "${specifier}"\n${validPackage}`)
    await expect(loaded(root)).rejects.toMatchObject({ code: "module_import_failed" })
  })
})

describe("PackageLoader module candidates", () => {
  it("maps .cjs to its .cts source, tries the literal .js after a missing .ts, and skips non-modules", async () => {
    const root = await fixture(`import type { A } from "./a.cjs"
import type { B } from "./b.js"
import type { C } from "./data.json"
import type { D } from "./."
import type { E } from "./missing.js"
${validPackage}`)
    await write(root, "a.cts", "export type A = string\n")
    await write(root, "b.js", "export {}\n")
    await write(root, "data.json", "{}\n")
    expect((await loaded(root)).modules).toEqual(["PACKAGE.ts", "WORKSPACE.ts", "a.cts", "b.js"])
  })

  it("lets WORKSPACE.ts name a module outside the workspace without scanning it", async () => {
    const root = await fixture()
    await write(root, "WORKSPACE.ts", `import type { Outside } from "../outside.ts"\n${workspace}`)
    const graph = await loaded(root)
    expect(graph.workspace.name).toBe("fixture")
    expect(graph.modules).toEqual(["PACKAGE.ts", "WORKSPACE.ts"])
  })

  it("accepts an import cycle among helpers that passes through no Package", async () => {
    const root = await fixture(`import { a } from "./a.ts"
import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: a() }) } })
`)
    await write(root, "a.ts", "import { b } from \"./b.ts\"\nexport const a = () => `echo ${b()}`\n")
    await write(root, "b.ts", "import { a } from \"./a.ts\"\nexport const b = () => typeof a\n")
    const graph = await loaded(root)
    expect(graph.modules).toEqual(["PACKAGE.ts", "WORKSPACE.ts", "a.ts", "b.ts"])
  })
})

describe("PackageLoader imports by name", () => {
  const notText = Uint8Array.of(0xff, 0xfe, 0xfd)

  it("follows a workspace package and records what it reaches, skipping what it cannot read or contain", async () => {
    const root = await fixture(`import * as NodeFs from "node:fs"
import type { Lib } from "@fixture/lib"
import type { Locked } from "@fixture/locked"
import type { Absolute } from "/absolute/module.ts"
import type { Installed } from "installed-dependency"
${validPackage}export const exists = typeof NodeFs.existsSync
`)
    await workspacePackage(root, "lib", {
      "index.ts": `import type { Util } from "./util.js"
import type { Sealed } from "./sealed.ts"
import type { Outside } from "../../../outside.ts"
export type Lib = string
`,
      "util.js": "export {}\n",
      "sealed.ts": "export type Sealed = string\n"
    })
    await workspacePackage(root, "locked", { "index.ts": "export type Locked = string\n" })
    await write(
      root,
      "node_modules/installed-dependency/package.json",
      JSON.stringify({ name: "installed-dependency", type: "module", exports: "./index.ts" })
    )
    await write(root, "node_modules/installed-dependency/index.ts", "export type Installed = string\n")
    // Not UTF-8: the scan cannot read either file, though the locked one still resolves and digests.
    await Fs.writeFile(NodePath.join(root, "packages/lib/sealed.ts"), notText)
    await Fs.writeFile(NodePath.join(root, "packages/locked/index.ts"), notText)
    const graph = await loaded(root)
    expect(graph.modules).toEqual([
      "PACKAGE.ts",
      "WORKSPACE.ts",
      "packages/lib/index.ts",
      "packages/lib/util.js",
      "packages/locked/index.ts"
    ])
    expect(graph.moduleRoots).toEqual(["packages/lib", "packages/locked"])
  })

  it("passes unrelated resolutions through while it probes, and skips a resolved file that does not exist", async () => {
    const root = await fixture(`import type { Lib } from "@fixture/alias"
import type { Ghost } from "@fixture/ghost"
${validPackage}`)
    await workspacePackage(root, "lib", { "index.ts": "export type Lib = string\n" })
    const require = createRequire(pathToFileURL(NodePath.join(root, "PACKAGE.ts")))
    const reentrant: Array<string> = []
    const hooks = registerHooks({
      resolve(request, context, nextResolve) {
        if (request === "@fixture/alias") {
          // A resolver that answers one name by resolving another re-enters the whole hook chain.
          const target = require.resolve("@fixture/lib")
          reentrant.push(target)
          return { url: pathToFileURL(target).href, shortCircuit: true }
        }
        if (request === "@fixture/ghost") {
          return { url: pathToFileURL(NodePath.join(root, "ghost/index.ts")).href, shortCircuit: true }
        }
        return nextResolve(request, context)
      }
    })
    let graph: PackageLoader.LoadedGraph
    try {
      graph = await loaded(root)
    } finally {
      hooks.deregister()
    }
    expect(reentrant).toEqual([NodePath.join(root, "packages/lib/index.ts")])
    expect(graph.modules).toEqual(["PACKAGE.ts", "WORKSPACE.ts", "packages/lib/index.ts"])
    expect(graph.moduleRoots).toEqual(["packages/lib"])
  })
})

describe("PackageLoader factory imports", () => {
  const factory = (imports: string) =>
    `import { Smithers as S } from "@smthrs/targets"
${imports}
const review = S.Flow({ flow: "review", summary: "Review the change.", featured: true })
export const factory = S.Factory({ summary: "Fixture factory.", flows: [review], on: { "issue.opened": "issue" } })
`

  /** A workspace declared in `.smithers/`, where FACTORY.ts and its helpers resolve `@smthrs/targets`. */
  const factoryFixture = async (factorySource: string): Promise<string> => {
    const root = await fixture()
    await Fs.rm(NodePath.join(root, "WORKSPACE.ts"))
    await write(root, ".smithers/WORKSPACE.ts", workspace)
    await write(root, ".smithers/FACTORY.ts", factorySource)
    return root
  }

  it("walks shared helpers once and allows the factory to import WORKSPACE.ts", async () => {
    const root = await factoryFixture(factory(`import type { Workspace } from "./WORKSPACE.ts"
import { a } from "./a.ts"
import { b } from "./b.ts"
export const label = a + b`))
    await write(root, ".smithers/a.ts", "import { c } from \"./c.ts\"\nexport const a = c\n")
    await write(root, ".smithers/b.ts", "import { c } from \"./c.ts\"\nexport const b = c\n")
    await write(root, ".smithers/c.ts", "export const c = \"c\"\n")
    const graph = await loaded(root)
    expect(graph.factory?.file).toBe(".smithers/FACTORY.ts")
    expect(graph.modules).toEqual([
      ".smithers/FACTORY.ts",
      ".smithers/WORKSPACE.ts",
      ".smithers/a.ts",
      ".smithers/b.ts",
      ".smithers/c.ts",
      "PACKAGE.ts"
    ])
  })

  it("rejects a factory that reaches a Package through a helper", async () => {
    const root = await factoryFixture(factory("import { a } from \"./a.ts\"\nexport const label = a"))
    await write(root, ".smithers/a.ts", "import type { Package } from \"../PACKAGE.ts\"\nexport const a = \"a\"\n")
    await expect(loaded(root)).rejects.toMatchObject({
      code: "factory_imports_package",
      path: ".smithers/FACTORY.ts",
      chain: [".smithers/FACTORY.ts", ".smithers/a.ts", "PACKAGE.ts"]
    })
  })

  it("reports a factory removed after discovery as an evaluation failure", async () => {
    const root = await factoryFixture(factory(""))
    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.factoryFile).toBe(".smithers/FACTORY.ts")
    await Fs.rm(NodePath.join(root, ".smithers/FACTORY.ts"))
    await expect(PackageLoader.load(discovery)).rejects.toMatchObject({
      code: "module_import_failed",
      message: expect.stringContaining("FACTORY.ts")
    })
  })
})

describe("PackageLoader package rules", () => {
  it("derives each package path from its directory", async () => {
    const root = await fixture()
    await write(root, "sub/PACKAGE.ts", validPackage)
    const graph = await loaded(root)
    expect(graph.packages.map((row) => [row.file, row.packagePath])).toEqual([["PACKAGE.ts", ""], [
      "sub/PACKAGE.ts",
      "sub"
    ]])
  })

  it("rejects a Package import whose case differs from the discovered file", async () => {
    const root = await fixture(`import type { Package as Sub } from "./sub/package.js"\n${validPackage}`)
    await write(root, "sub/PACKAGE.ts", validPackage)
    await expect(loaded(root)).rejects.toMatchObject({
      code: "case_collision",
      path: "PACKAGE.ts",
      message: expect.stringContaining("resolves to sub/PACKAGE.ts under different case (sub/package.ts)")
    })
  })

  it("rejects Packages that import each other, naming the full chain", async () => {
    const root = await fixture()
    await write(root, "a/PACKAGE.ts", `import type { Package as B } from "../b/PACKAGE.ts"\n${validPackage}`)
    await write(root, "b/PACKAGE.ts", `import type { Package as A } from "../a/PACKAGE.ts"\n${validPackage}`)
    await expect(loaded(root)).rejects.toMatchObject({
      code: "package_import_cycle",
      path: "a/PACKAGE.ts",
      chain: ["a/PACKAGE.ts", "b/PACKAGE.ts", "a/PACKAGE.ts"]
    })
  })

  it("loads two Packages that share one helper", async () => {
    const root = await fixture(`import type { Shared } from "./shared.ts"\n${validPackage}`)
    await write(root, "sub/PACKAGE.ts", `import type { Shared } from "../shared.ts"\n${validPackage}`)
    await write(root, "shared.ts", "export type Shared = string\n")
    const graph = await loaded(root)
    expect(graph.packages.map((row) => row.file)).toEqual(["PACKAGE.ts", "sub/PACKAGE.ts"])
    expect(graph.modules).toEqual(["PACKAGE.ts", "WORKSPACE.ts", "shared.ts", "sub/PACKAGE.ts"])
  })

  it("rejects a target exported beside the Package", async () => {
    const root = await fixture(`${validPackage}export const run = S.Shell.Run({ shell: "true" })\n`)
    await expect(loaded(root)).rejects.toMatchObject({
      code: "naked_target_export",
      path: "PACKAGE.ts",
      message: expect.stringContaining("exports a naked target \"run\"")
    })
  })

  it("wraps a PackageError a declaration throws, keeping the thrown one as the cause", async () => {
    const source = NodePath.resolve(import.meta.dirname, "../src/PackageError.ts")
    const root = await fixture(`import { PackageError } from ${JSON.stringify(pathToFileURL(source).href)}
throw new PackageError("module_missing", "thrown by the declaration", { path: "elsewhere.ts" })
${validPackage}`)
    await expect(loaded(root)).rejects.toMatchObject({
      code: "module_import_failed",
      message: expect.stringContaining("module_missing: thrown by the declaration"),
      cause: { code: "module_missing", path: "elsewhere.ts" }
    })
  })

  it("keys the graph by child repositories and pruned directories", async () => {
    const root = await fixture()
    const discovery = await PackageDiscovery.discover(root)
    const first = await PackageLoader.load(discovery)
    expect(await PackageLoader.load({ ...discovery })).toBe(first)
    const withRepository = await PackageLoader.load({ ...discovery, repositories: [{ name: "child", path: "child" }] })
    expect(withRepository).not.toBe(first)
    const withPruned = await PackageLoader.load({ ...discovery, pruned: ["vendor"] })
    expect(withPruned).not.toBe(first)
    expect(withPruned).not.toBe(withRepository)
  })
})

describe("PackageLoader workspace probes", () => {
  it("probes a missing workspace file as unknown and reports it when loaded", async () => {
    const root = await fixture()
    await expect(PackageLoader.probeCacheDirectory(root, "MISSING.ts")).resolves.toBeUndefined()
    await expect(PackageLoader.loadWorkspaceDeclaration(root, "MISSING.ts")).rejects.toMatchObject({
      code: "module_import_failed",
      path: "MISSING.ts"
    })
  })

  it("passes a workspace-local runtime conflict through as its own typed error", async () => {
    const root = await fixture()
    await write(
      root,
      "node_modules/effect/package.json",
      JSON.stringify({ name: "effect", type: "module", exports: "./index.js" })
    )
    await write(root, "node_modules/effect/index.js", "export {}\n")
    await expect(PackageLoader.loadWorkspaceDeclaration(root, "WORKSPACE.ts")).rejects.toMatchObject({
      code: "declaration_dependency_mismatch",
      message: expect.stringContaining(NodePath.join(root, "node_modules/effect/package.json"))
    })
  })
})
