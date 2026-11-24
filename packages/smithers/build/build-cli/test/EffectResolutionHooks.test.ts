/**
 * The resolver hooks, exercised in this process through real native imports.
 *
 * The neighbouring suites run the resolver in child processes, which proves
 * the end-to-end contract; these cases drive the same hooks through
 * `importDeclarationModule`, the entry the CLI uses, and observe each rule by
 * the module it makes Node evaluate: the format a file runs in, the URL it sees
 * as `import.meta.url`, and the copy of a vendored adapter it receives.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Vm from "node:vm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
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

/**
 * A published `@smthrs/cli` runs as one file that holds Effect and the owned
 * packages, and publishes a table of them under a global symbol. A declaration
 * module must get those instances, not a second copy read from the files
 * installed beside the bundle.
 */
describe("a CLI that runs as one file", () => {
  const key = Symbol.for("smthrs/bundle")
  const holder = globalThis as { [name: symbol]: unknown }

  afterEach(() => {
    delete holder[key]
  })

  /** A table holding one module, published at a file with other contents. */
  const holding = async (name: string, instance: Record<string, unknown>, onLoad = () => {}) => {
    const file = await write(`${name}/installed/Marker.js`, "export const named = \"read from the file\"\n")
    holder[key] = {
      url: import.meta.url,
      modules: new Map([["effect/OneFileMarker", () => {
        onLoad()
        return instance
      }]]),
      addresses: new Map([["effect/OneFileMarker", { url: file }]])
    }
    return file
  }

  it("answers an owned import with the bundle's own module, under the same export names", async () => {
    const instance = { default: "the default", named: { shared: true }, "not-an-identifier": 2 }
    let initialized = 0
    await holding("one-file", instance, () => {
      initialized += 1
    })
    const url = await write(
      "one-file/PACKAGE.ts",
      [
        "import marker, * as all from \"effect/OneFileMarker\"",
        "export const seen = { marker, named: all.named, odd: all[\"not-an-identifier\"], names: Object.keys(all).sort() }"
      ].join("\n") + "\n"
    )
    const seen = (await load(url)).seen as { readonly named: unknown }
    expect(seen).toEqual({
      marker: "the default",
      named: { shared: true },
      odd: 2,
      names: ["default", "named", "not-an-identifier"]
    })
    // The same object, not a copy of it.
    expect(seen.named).toBe(instance.named)
    expect(initialized).toBeGreaterThan(0)
  })

  it("resolves an owned import to the file it is published as", async () => {
    const file = await holding("one-file-address", { named: 1 })
    const url = await write(
      "one-file-address/PACKAGE.ts",
      "export const address: string = import.meta.resolve(\"effect/OneFileMarker\")\n"
    )
    expect((await load(url)).address).toBe(file)
    expect(fileURLToPath(file)).toContain("one-file-address")
  })

  it("gives the bundle's module to an import that names the file", async () => {
    const instance = { named: { shared: true } }
    const file = await holding("one-file-url", instance)
    const url = await write(
      "one-file-url/PACKAGE.ts",
      [
        `import { named as byUrl } from ${JSON.stringify(file)}`,
        `import { named as withQuery } from ${JSON.stringify(`${file}?copy=1`)}`,
        "export const seen = { byUrl, withQuery }"
      ].join("\n") + "\n"
    )
    const seen = (await load(url)).seen as { readonly byUrl: unknown; readonly withQuery: unknown }
    expect(seen.byUrl).toBe(instance.named)
    expect(seen.withQuery).toBe(instance.named)
  })

  it("gives the bundle's module to a require that ordinary resolution leads to the file", async () => {
    const instance = { named: { shared: true } }
    const file = await holding("one-file-required", instance)
    const url = await write(
      "one-file-required/PACKAGE.ts",
      [
        "import { createRequire } from \"node:module\"",
        `export const required = createRequire(import.meta.url)(${JSON.stringify(fileURLToPath(file))}).named`
      ].join("\n") + "\n"
    )
    expect((await load(url)).required).toBe(instance.named)
  })

  it("leaves an owned import the bundle does not hold to the installation", async () => {
    holder[key] = { url: import.meta.url, modules: new Map(), addresses: new Map() }
    const url = await write(
      "one-file-absent/PACKAGE.ts",
      "import * as Option from \"effect/Option\"\nexport const some: boolean = Option.isSome(Option.some(1))\n"
    )
    expect((await load(url)).some).toBe(true)
  })

  it("leaves a module at a URL that is not a file to its own loader", async () => {
    await holding("one-file-data", { named: 1 })
    const url = await write(
      "one-file-data/PACKAGE.ts",
      "import given from \"data:text/javascript,export default 'from a data URL'\"\nexport const seen: string = given\n"
    )
    expect((await load(url)).seen).toBe("from a data URL")
  })

  it("leaves a CommonJS require of an owned name to ordinary resolution", async () => {
    await holding("one-file-require", { named: 1 })
    const url = await write(
      "one-file-require/PACKAGE.ts",
      [
        "import { createRequire } from \"node:module\"",
        "let code: unknown = \"loaded\"",
        "try {",
        "  createRequire(import.meta.url)(\"effect/OneFileMarker\")",
        "} catch (cause) {",
        "  code = (cause as { code?: unknown }).code",
        "}",
        "export const required = code"
      ].join("\n") + "\n"
    )
    expect((await load(url)).required).toMatch(/NOT_FOUND|NOT_EXPORTED/)
  })
})

describe("the address a declaration module is evaluated at", () => {
  const namespaceOf = (url: unknown) => new URL(url as string).searchParams.get("tsx-namespace")

  it("is the same from start to start, and new for each evaluation in one start", async () => {
    const url = await write("stable/PACKAGE.ts", "export const self: string = import.meta.url\n")
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 16)
    const first = await load(url)
    const second = await load(url)
    expect(namespaceOf(first.self)).toBe(`${hash}-1`)
    expect(namespaceOf(second.self)).toBe(`${hash}-2`)
    expect(first).not.toBe(second)
  })

  it("evaluates given source at a URL with no file, and its imports in the same namespace", async () => {
    const helper = await write("given/PACKAGE.ts", "export const self: string = import.meta.url\n")
    const url = pathToFileURL(NodePath.join(root, "given", ".entry.mjs")).href
    const resolver = new URL("../src/effect-resolution.js", import.meta.url).href
    const source = [
      `import { self } from ${JSON.stringify(helper)}`,
      "export const entry = import.meta.url",
      "export const imported = self"
    ].join("\n") + "\n"
    const script = await write(
      "given/run.mjs",
      [
        `import { importDeclarationModule } from ${JSON.stringify(resolver)}`,
        `const url = ${JSON.stringify(url)}`,
        `const loaded = await importDeclarationModule(url, import.meta.url, ${JSON.stringify(source)})`,
        "const absent = await importDeclarationModule(url, import.meta.url).then(() => undefined, (cause) => cause.code)",
        "console.log(JSON.stringify({ entry: loaded.entry, imported: loaded.imported, absent }))"
      ].join("\n") + "\n"
    )
    const seen = JSON.parse(execFileSync(process.execPath, [fileURLToPath(script)], { encoding: "utf8" }))
    expect(seen.entry.startsWith(url)).toBe(true)
    expect(namespaceOf(seen.imported)).toBe(namespaceOf(seen.entry))
    // Only that one import was answered from the given source.
    expect(seen.absent).toBe("ERR_MODULE_NOT_FOUND")
  })
})

describe("given source evaluated twice at once", () => {
  it("gives each evaluation its own source", async () => {
    const url = pathToFileURL(NodePath.join(root, "concurrent", ".entry.mjs")).href
    const [one, two] = await Promise.all([
      importDeclarationModule(url, import.meta.url, "export const which = 1\n"),
      importDeclarationModule(url, import.meta.url, "export const which = 2\n")
    ]) as ReadonlyArray<{ readonly which: number }>
    expect([one!.which, two!.which]).toEqual([1, 2])
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

describe("a revision's files in place of the changed ones", () => {
  const path = (url: string) => fileURLToPath(url)

  it("reads each changed module as the revision held it, and a deleted one from the place it had", async () => {
    await write("revision/package.json", "{\"type\":\"module\"}\n")
    const typed = await write("revision/typed.ts", "export const typed: string = \"now\"\n")
    const plain = await write("revision/plain.mjs", "export const plain = \"now\"\n")
    const data = await write("revision/data.json", "{\"data\":\"now\"}\n")
    const same = await write("revision/same.ts", "export const same: string = \"unchanged\"\n")
    const gone = pathToFileURL(NodePath.join(root, "revision", "gone.ts")).href
    const removed = pathToFileURL(NodePath.join(root, "revision", "removed.mjs")).href
    const entry = await write(
      "revision/PACKAGE.ts",
      [
        "import { typed } from \"./typed.ts\"",
        "import { plain } from \"./plain.mjs\"",
        "import data from \"./data.json\" with { type: \"json\" }",
        "import { same } from \"./same.ts\"",
        "import { gone } from \"./gone.js\"",
        `import { removed } from ${JSON.stringify(removed)}`,
        "export const seen = { typed, plain, data: data.data, same, gone, removed }"
      ].join("\n") + "\n"
    )
    const revision = {
      changed: new Set([typed, plain, data, gone, removed].map(path)),
      texts: new Map([
        [path(typed), "export const typed: string = \"then\"\n"],
        [path(plain), "export const plain = \"then\"\n"],
        [path(data), "{\"data\":\"then\"}\n"],
        [path(gone), "export const gone: string = \"then\"\n"],
        [path(removed), "export const removed = \"then\"\n"]
      ])
    }
    const loaded = await importDeclarationModule(entry, import.meta.url, undefined, revision) as {
      readonly seen: unknown
    }
    expect(loaded.seen).toEqual({
      typed: "then",
      plain: "then",
      data: "then",
      same: "unchanged",
      gone: "then",
      removed: "then"
    })
    // The checkout's own evaluation is untouched, and still lacks the deleted modules.
    await expect(load(entry)).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" })
  })

  it("refuses a changed module the revision holds no text for, never reading it as it is now", async () => {
    const added = await write("revision-added/added.ts", "export const added: string = \"now\"\n")
    const entry = await write(
      "revision-added/PACKAGE.ts",
      "import { added } from \"./added.ts\"\nexport const seen = added\n"
    )
    await expect(
      importDeclarationModule(entry, import.meta.url, undefined, { changed: new Set([path(added)]), texts: new Map() })
    ).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
      message: `${path(added)} changed since the revision, which holds no module there`
    })
  })

  it("leaves an import that resolves nowhere failing, in its namespace and outside it", async () => {
    const resolver = new URL("../src/effect-resolution.js", import.meta.url).href
    const entry = await write(
      "revision-missing/PACKAGE.ts",
      [
        "const code = (specifier: string) => import(specifier).then(() => \"loaded\", (cause) => cause.code)",
        "export const bare = await code(\"smithers-no-such-package\")",
        "export const relative = await code(\"./nowhere.js\")",
        "await new Promise((resolve) => setTimeout(resolve, 250))"
      ].join("\n") + "\n"
    )
    const script = await write(
      "revision-missing/run.mjs",
      [
        `import { importDeclarationModule } from ${JSON.stringify(resolver)}`,
        `const held = ${JSON.stringify(NodePath.join(root, "revision-missing", "held.mjs"))}`,
        "const revision = { changed: new Set([held]), texts: new Map([[held, \"export const held = 1\\n\"]]) }",
        `const pending = importDeclarationModule(${JSON.stringify(entry)}, import.meta.url, undefined, revision)`,
        "// This module is in no namespace: the revision's text is not its to read.",
        "const outside = await import(\"./held.mjs\").then(() => \"loaded\", (cause) => cause.code)",
        "const loaded = await pending",
        "console.log(JSON.stringify({ bare: loaded.bare, relative: loaded.relative, outside }))"
      ].join("\n") + "\n"
    )
    const seen = JSON.parse(execFileSync(process.execPath, [fileURLToPath(script)], { encoding: "utf8" }))
    expect(seen).toEqual({
      bare: "ERR_MODULE_NOT_FOUND",
      relative: "ERR_MODULE_NOT_FOUND",
      outside: "ERR_MODULE_NOT_FOUND"
    })
  })
})
