/**
 * The resolver hooks, exercised in this process through real native imports.
 *
 * The neighbouring suites run the resolver in child processes, which proves
 * the end-to-end contract; these cases drive the same hooks through
 * `importDeclarationModule`, the entry the CLI uses, and observe each rule by
 * the module it makes Node evaluate: the format a file runs in, the URL it sees
 * as `import.meta.url`, and the copy of a vendored adapter it receives.
 */
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Vm from "node:vm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildModuleUrl, importDeclarationModule, installEffectResolution } from "../src/effect-resolution.js"

const require = createRequire(import.meta.url)
const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const cliEntry = new URL("../src/Cli.ts", import.meta.url).href

/** Reports the format Node evaluated the module in: ES modules have no `require`. */
const formatProbe = "typeof require === \"undefined\" ? \"module\" : \"commonjs\""

let root = ""

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-resolver-hooks-")))
})

afterAll(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const write = async (relative: string, text: string) => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
  return pathToFileURL(path).href
}

const load = (url: string) => importDeclarationModule(url, import.meta.url) as Promise<Record<string, unknown>>

describe("the format a declaration module evaluates in", () => {
  it.each([
    ["PACKAGE.ts"],
    ["WORKSPACE.ts"],
    [".smithers/tools.ts"],
    ["flows/release/flow.ts"],
    [`.smithers-${"a".repeat(64)}-registry.ts`]
  ])("runs %s as an ES module inside a CommonJS package", async (name) => {
    const directory = `commonjs-${name.replace(/[^a-z]/gi, "")}`
    await write(`${directory}/package.json`, "{\"type\":\"commonjs\"}\n")
    const url = await write(`${directory}/${name}`, `export const format: string = ${formatProbe}\n`)
    expect((await load(url)).format).toBe("module")
  })

  it("keeps an ordinary TypeScript file in its package's CommonJS format", async () => {
    await write("ordinary/package.json", "{\"type\":\"commonjs\"}\n")
    const url = await write("ordinary/other.ts", `export const format: string = ${formatProbe}\n`)
    expect((await load(url)).format).toBe("commonjs")
  })

  it("runs relative typed helpers, and their own helpers, in the declaration's ES-module graph", async () => {
    await write("helpers/package.json", "{\"type\":\"commonjs\"}\n")
    await write("helpers/deep.ts", `export const deep: string = ${formatProbe}\n`)
    await write(
      "helpers/helper.ts",
      `import { deep } from "./deep.ts"\nexport const helper: string = ${formatProbe}\nexport { deep }\n`
    )
    const url = await write(
      "helpers/PACKAGE.ts",
      [
        "import * as Path from \"node:path\"",
        "import { deep, helper } from \"./helper.ts\"",
        "export const formats = { deep, helper }",
        "export const separator = Path.sep",
        ""
      ].join("\n")
    )
    const loaded = await load(url)
    expect(loaded.formats).toEqual({ deep: "module", helper: "module" })
    expect(loaded.separator).toBe(NodePath.sep)
  })

  it("loads an absolute Effect URL from the CLI's own Effect instance, not a namespaced copy", async () => {
    const schemaUrl = pathToFileURL(require.resolve("effect/Schema")).href
    const url = await write(
      "absolute-effect/PACKAGE.ts",
      `import * as Schema from ${JSON.stringify(schemaUrl)}\nexport const schema = Schema.String\n`
    )
    const Schema = await import("effect/Schema")
    expect((await load(url)).schema).toBe(Schema.String)
  })

  it("lets a CommonJS dependency of a declaration require its typed sibling", async () => {
    await write("bridged/package.json", "{\"type\":\"commonjs\"}\n")
    await write("bridged/leaf.ts", "export const leaf: string = \"from leaf.ts\"\n")
    await write("bridged/bridge.js", `exports.leaf = require("./leaf.ts").leaf\nexports.format = ${formatProbe}\n`)
    const url = await write(
      "bridged/PACKAGE.ts",
      "import bridge from \"./bridge.js\"\nexport const leaf: string = bridge.leaf\nexport const format: string = bridge.format\n"
    )
    expect(await load(url)).toMatchObject({ leaf: "from leaf.ts", format: "commonjs" })
  })

  it("resolves an import that has no referring module", async () => {
    const imported = await Vm.runInThisContext("import(\"data:text/javascript,export default 9\")", {
      importModuleDynamically: Vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
    }) as { readonly default: number }
    expect(imported.default).toBe(9)
  })

  it("keeps a URL whose path merely contains tsx's namespace marker", async () => {
    const url = await write("tsx-namespace-lookalike/value.mjs", "export const self = import.meta.url\n")
    const imported = await Vm.runInThisContext(`import(${JSON.stringify(url)})`, {
      importModuleDynamically: Vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
    }) as { readonly self: string }
    expect(imported.self).toBe(url)
  })

  it("leaves a module that is not a file, such as a data: URL, to its own format", async () => {
    expect((await load("data:text/javascript,export default 4")).default).toBe(4)
  })
})

describe("packages resolved from their owner, not the importer", () => {
  it("resolves the CLI's own target definitions for a declaration outside any installation", async () => {
    const url = await write(
      "unowned/PACKAGE.ts",
      "import * as Input from \"@smthrs/targets/Input\"\nexport const file = Input.file(\"a.ts\")\n"
    )
    const Input = await import("@smthrs/targets/Input")
    expect((await load(url)).file).toEqual(Input.file("a.ts"))
  })

  it("resolves an explicitly owned package and its subpaths from the owner's installation", async () => {
    await write(
      "owner/node_modules/owned-agent/package.json",
      JSON.stringify({
        name: "owned-agent",
        type: "module",
        exports: { ".": "./index.js", "./tools": "./tools.js" }
      })
    )
    await write("owner/node_modules/owned-agent/index.js", "export const copy = \"owner\"\n")
    await write("owner/node_modules/owned-agent/tools.js", "export const tools = \"owner tools\"\n")
    const owner = await write("owner/main.mjs", "export {}\n")
    // The owner's query and fragment are not part of its identity.
    installEffectResolution({ "owned-agent": `${owner}?revision=1#entry` })
    const url = await write(
      "consumer/PACKAGE.ts",
      "import { copy } from \"owned-agent\"\nimport { tools } from \"owned-agent/tools\"\nexport const found = [copy, tools]\n"
    )
    expect((await load(url)).found).toEqual(["owner", "owner tools"])
  })
})

describe("buildModuleUrl", () => {
  it("marks a file URL and admits that file for ES-module evaluation, with or without the mark", async () => {
    await write("admitted/package.json", "{\"type\":\"commonjs\"}\n")
    const url = await write("admitted/plain.js", `export const format = ${formatProbe}\n`)
    await write("admitted/control.js", `exports.format = ${formatProbe}\n`)
    const marked = buildModuleUrl(url)
    expect(new URL(marked).searchParams.get("smithers-build-module")).toBe("1")
    expect(marked.startsWith(`${url}?`)).toBe(true)
    expect((await load(marked)).format).toBe("module")
    // Admission is recorded per file, so the unmarked URL tsx later restores keeps it.
    expect((await load(url)).format).toBe("module")
    // A sibling nobody admitted stays in its package's format.
    expect((await load(url.replace("plain.js", "control.js"))).format).toBe("commonjs")
  })

  it("admits the file behind a nested import's query that tsx encoded into the path", async () => {
    await write("encoded/package.json", "{\"type\":\"commonjs\"}\n")
    const url = await write("encoded/nested.js", `export const format = ${formatProbe}\n`)
    buildModuleUrl(`${url}%3Fnamespace=nested?tsx-namespace=nested`)
    expect((await load(url)).format).toBe("module")
  })

  it("marks a non-file URL without admitting anything", () => {
    const marked = buildModuleUrl("https://example.invalid/PACKAGE.ts?x=1")
    expect(marked).toBe("https://example.invalid/PACKAGE.ts?x=1&smithers-build-module=1")
  })
})

describe("a missing import from this package", () => {
  it("reports a package that is neither installed nor vendored", async () => {
    await expect(importDeclarationModule("@smthrs-missing/adapter", cliEntry)).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND"
    })
  })

  it("reports an unexported adapter subpath unchanged instead of consulting the vendored copy", async () => {
    await expect(importDeclarationModule("@effect/platform-node/internal/x", cliEntry)).rejects.toMatchObject({
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED"
    })
  })
})

describe("the vendored adapters an installed package carries in dist/vendor", () => {
  const dist = NodePath.join(packageRoot, "dist")
  const token = `Probe${process.pid}${Date.now()}`
  const vendor = NodePath.join(dist, "vendor")
  const barrel = NodePath.join(vendor, "platform-node-shared.js")
  // Only what this suite creates is removed: a real build may already carry dist and its barrel.
  const createdFiles: Array<string> = []
  const createdDirectories: Array<string> = []
  let ownBarrel = false

  beforeAll(async () => {
    const file = async (path: string, text: string) => {
      const directory = await Fs.mkdir(NodePath.dirname(path), { recursive: true })
      if (directory !== undefined) createdDirectories.push(directory)
      await Fs.writeFile(path, text, { encoding: "utf8", flag: "wx" })
      createdFiles.push(path)
    }
    await file(NodePath.join(vendor, "node", `${token}.js`), "export const copy = \"vendored subpath\"\n")
    await file(NodePath.join(vendor, `${token}-subpath.mjs`), `export * from "@effect/platform-node/${token}"\n`)
    await file(NodePath.join(vendor, `${token}-absent.mjs`), `export * from "@effect/platform-node/${token}Absent"\n`)
    ownBarrel = await Fs.access(barrel).then(() => false, () => true)
    if (ownBarrel) await file(barrel, "export const copy = \"vendored barrel\"\n")
    await file(NodePath.join(vendor, `${token}-barrel`, "main.mjs"), "export * from \"@effect/platform-node-shared\"\n")
    // A broken installation nearer the importer than the development dependency.
    await file(
      NodePath.join(vendor, `${token}-barrel`, "node_modules", "@effect", "platform-node-shared", "package.json"),
      JSON.stringify({ name: "@effect/platform-node-shared", type: "module", exports: "./missing.js" })
    )
  })

  afterAll(async () => {
    await Promise.all(createdFiles.map((path) => Fs.rm(path, { force: true })))
    await Fs.rm(NodePath.join(vendor, `${token}-barrel`), { recursive: true, force: true })
    for (const directory of createdDirectories.sort((left, right) => right.length - left.length)) {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  const vendorUrl = (name: string) => pathToFileURL(NodePath.join(vendor, name)).href

  it("serves an adapter subpath the installation cannot resolve from the vendored modules", async () => {
    expect((await load(vendorUrl(`${token}-subpath.mjs`))).copy).toBe("vendored subpath")
  })

  it("still reports a subpath the vendored modules do not carry", async () => {
    await expect(load(vendorUrl(`${token}-absent.mjs`))).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" })
  })

  it("serves the vendored barrel when the installed adapter package cannot be loaded", async () => {
    const served = await load(vendorUrl(`${token}-barrel/main.mjs`))
    if (ownBarrel) expect(served.copy).toBe("vendored barrel")
    else expect(Object.keys(served).sort()).toEqual(Object.keys(await load(pathToFileURL(barrel).href)).sort())
  })
})
