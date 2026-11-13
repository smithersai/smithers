import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  computeClosure,
  extractSpecifiers,
  loadResolverConfig,
  type ResolverConfig,
  ResolverConfigError,
  resolveSpecifier,
  type TreeView
} from "../src/Resolver.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const closureOf = async (entries: ReadonlyArray<string>) => {
  const config = await loadResolverConfig({ workspaceRoot: root })
  return computeClosure({ config, entries })
}

const paths = (outcome: Awaited<ReturnType<typeof closureOf>>): ReadonlyArray<string> =>
  outcome.result.files.map((file) => file.path)

/** A TreeView answering from the real filesystem, following links. */
const statView = (): TreeView => ({
  root,
  async kind(relativePath) {
    try {
      const stat = await Fs.stat(NodePath.join(root, relativePath))
      return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other"
    } catch {
      return null
    }
  }
})

const resolver = async (fromFile = "entry.ts") => {
  const config = await loadResolverConfig({ workspaceRoot: root })
  const view = statView()
  return (specifier: string, mode?: "require") =>
    resolveSpecifier(config, view, fromFile, { specifier, dynamic: false, mode })
}

const nested = (depth: number, leaf: unknown): unknown => depth === 0 ? leaf : { default: nested(depth - 1, leaf) }

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-resolver-edges-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("extraction edges", () => {
  it("bounds a long dynamic expression and records an argument-less call whole", () => {
    const long = "x".repeat(250)
    const found = extractSpecifiers("a.ts", `import(${long})\nrequire()\n`)
    expect(found).toEqual([
      { specifier: `${"x".repeat(197)}...`, dynamic: true },
      { specifier: "require()", dynamic: true }
    ])
    expect(found[0]!.specifier).toHaveLength(200)
  })

  it("skips local re-exports and non-literal import-equals references", () => {
    const found = extractSpecifiers(
      "a.ts",
      `const a = 1\nexport { a }\nimport legacy = require(name)\nimport empty = require()\nimport "./kept"\n`
    )
    expect(found).toEqual([{ specifier: "./kept", dynamic: false }])
  })
})

describe("tsconfig edges", () => {
  it("appends .json to an extensionless relative extends target", async () => {
    await write("tsconfig.json", JSON.stringify({ extends: "./configs/base" }))
    await write("configs/base.json", JSON.stringify({ compilerOptions: { baseUrl: "../src" } }))
    const config = await loadResolverConfig({ workspaceRoot: root })
    expect(config.baseUrl).toBe("src")
    expect(config.sources.map((source) => source.path)).toEqual(["tsconfig.json", "configs/base.json"])
  })

  it("follows eight extends hops and refuses the ninth", async () => {
    const chain = async (length: number) => {
      for (let index = 0; index < length; index += 1) {
        await write(`c${index}.json`, JSON.stringify({ extends: `./c${index + 1}.json` }))
      }
      await write(`c${length}.json`, JSON.stringify({ compilerOptions: { baseUrl: "." } }))
    }
    await chain(8)
    const accepted = await loadResolverConfig({ workspaceRoot: root, tsconfig: "c0.json" })
    expect(accepted.sources).toHaveLength(9)
    expect(accepted.baseUrl).toBe("")
    await chain(9)
    const refused = await loadResolverConfig({ workspaceRoot: root, tsconfig: "c0.json" }).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(refused).toBeInstanceOf(ResolverConfigError)
    expect(refused).toMatchObject({
      reason: "extends_too_deep",
      message: "tsconfig extends chain exceeds 8 files at c9.json"
    })
  })
})

describe("tsconfig paths edges", () => {
  const pathsConfig = async (paths: Record<string, ReadonlyArray<string>>): Promise<ResolverConfig> => {
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths } }))
    return loadResolverConfig({ workspaceRoot: root })
  }

  it("maps a \".\" target to the workspace root index", async () => {
    const config = await pathsConfig({ app: ["."] })
    expect(config.paths).toEqual([{ pattern: "app", targets: [""] }])
    await write("index.ts", `export const app = 1\n`)
    await write("entry.ts", `import "app"\n`)
    const outcome = await computeClosure({ config, entries: ["entry.ts"] })
    expect(outcome.result.unresolved).toEqual([])
    expect(paths(outcome)).toEqual(["entry.ts", "index.ts"])
  })

  it("keeps the longest prefix when a less specific pattern sorts later, and tries targets in order", async () => {
    const config = await pathsConfig({ "$lib/*": ["missing/*", "src/lib/*"], "*": ["vendor/*"] })
    expect(config.paths.map((entry) => entry.pattern)).toEqual(["$lib/*", "*"])
    await write("src/lib/util.ts", `export const util = 1\n`)
    await write("vendor/$lib/util.ts", `export const decoy = 1\n`)
    const view = statView()
    await expect(resolveSpecifier(config, view, "entry.ts", { specifier: "$lib/util", dynamic: false }))
      .resolves.toEqual({ specifier: "$lib/util", status: "resolved-file", resolved: "src/lib/util.ts" })
  })

  it("uses a wildcard pattern's star-free target as written", async () => {
    const config = await pathsConfig({ "config/*": ["src/config.ts"] })
    await write("src/config.ts", `export const config = 1\n`)
    await expect(resolveSpecifier(config, statView(), "entry.ts", { specifier: "config/anything", dynamic: false }))
      .resolves.toEqual({ specifier: "config/anything", status: "resolved-file", resolved: "src/config.ts" })
  })

  it("does not probe a baseUrl join that climbs out of the workspace", async () => {
    const config = await pathsConfig({})
    await write("escape.ts", `export const escape = 1\n`)
    await expect(resolveSpecifier(config, statView(), "entry.ts", { specifier: "pkg/../../escape", dynamic: false }))
      .resolves.toEqual({ specifier: "pkg/../../escape", status: "unresolved" })
  })
})

describe("package specifier edges", () => {
  it.each(["@scope", "@/x", "@scope/"])("refuses the malformed scoped specifier %s", async (specifier) => {
    await write("node_modules/@scope/package.json", JSON.stringify({ name: "@scope" }))
    const resolve = await resolver()
    await expect(resolve(specifier)).resolves.toEqual({ specifier, status: "unresolved" })
  })

  it("admits any subpath of a package whose manifest is missing, oversized, or not an object", async () => {
    await Fs.mkdir(NodePath.join(root, "node_modules/bare"), { recursive: true })
    const blocking = { exports: { ".": "./index.js" } }
    await write(
      "node_modules/huge/package.json",
      JSON.stringify({ ...blocking, padding: "x".repeat(1024 * 1024) })
    )
    await write("node_modules/listed/package.json", "[]")
    await write("node_modules/plain/package.json", JSON.stringify(blocking))
    const resolve = await resolver()
    for (const name of ["bare", "huge", "listed"]) {
      await expect(resolve(`${name}/deep/file`)).resolves.toEqual({
        specifier: `${name}/deep/file`,
        status: "package",
        packageName: name
      })
    }
    await expect(resolve("plain/deep/file")).resolves.toEqual({ specifier: "plain/deep/file", status: "unresolved" })
  })

  it("admits only the root subpath for string and array exports", async () => {
    await write("node_modules/text/package.json", JSON.stringify({ exports: "./index.js" }))
    await write("node_modules/list/package.json", JSON.stringify({ exports: ["./index.js"] }))
    const resolve = await resolver()
    for (const name of ["text", "list"]) {
      await expect(resolve(name)).resolves.toEqual({ specifier: name, status: "package", packageName: name })
      await expect(resolve(`${name}/sub`)).resolves.toEqual({ specifier: `${name}/sub`, status: "unresolved" })
    }
  })

  it.each([["null", null], ["a number", 42]])("admits no subpath when exports is %s", async (_label, exports) => {
    await write("node_modules/closed/package.json", JSON.stringify({ exports }))
    const resolve = await resolver()
    await expect(resolve("closed")).resolves.toEqual({ specifier: "closed", status: "unresolved" })
  })

  it("treats a conditions-only exports object as the root subpath", async () => {
    await write("node_modules/sugar/package.json", JSON.stringify({ exports: { import: "./i.js", require: "./r.js" } }))
    await write("node_modules/blocked/package.json", JSON.stringify({ exports: { import: null } }))
    const resolve = await resolver()
    await expect(resolve("sugar")).resolves.toEqual({ specifier: "sugar", status: "package", packageName: "sugar" })
    await expect(resolve("sugar/sub")).resolves.toEqual({ specifier: "sugar/sub", status: "unresolved" })
    await expect(resolve("blocked")).resolves.toEqual({ specifier: "blocked", status: "unresolved" })
  })

  it("prefers the most specific export pattern regardless of declaration order", async () => {
    await write(
      "node_modules/feat/package.json",
      JSON.stringify({ exports: { "./features/*": null, "./*": "./dist/*.js" } })
    )
    const resolve = await resolver()
    await expect(resolve("feat/features/x")).resolves.toEqual({ specifier: "feat/features/x", status: "unresolved" })
    await expect(resolve("feat/other")).resolves.toEqual({
      specifier: "feat/other",
      status: "package",
      packageName: "feat"
    })
  })

  it("admits export conditions nested eight levels deep and refuses nine", async () => {
    await write("node_modules/deep8/package.json", JSON.stringify({ exports: { ".": nested(8, "./x.js") } }))
    await write("node_modules/deep9/package.json", JSON.stringify({ exports: { ".": nested(9, "./x.js") } }))
    const resolve = await resolver()
    await expect(resolve("deep8")).resolves.toEqual({ specifier: "deep8", status: "package", packageName: "deep8" })
    await expect(resolve("deep9")).resolves.toEqual({ specifier: "deep9", status: "unresolved" })
  })
})

describe("package imports edges", () => {
  it("refuses the bare # and #/ forms without reading a manifest", async () => {
    await write("package.json", "{ not json")
    const resolve = await resolver()
    for (const specifier of ["#", "#/x"]) {
      await expect(resolve(specifier)).resolves.toEqual({ specifier, status: "unresolved" })
    }
  })

  it("leaves #imports unresolved outside any package scope", async () => {
    await write("entry.ts", `import "#x"\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["entry.ts"])
    expect(outcome.result.unresolved).toEqual([{ file: "entry.ts", specifier: "#x" }])
  })

  it("lets a non-object manifest end the scope search and still join the closure", async () => {
    await write("package.json", JSON.stringify({ imports: { "#x": "./x.ts" } }))
    await write("app/package.json", "[]")
    await write("app/entry.ts", `import "#x"\n`)
    await write("x.ts", `export const x = 1\n`)
    const outcome = await closureOf(["app/entry.ts"])
    expect(paths(outcome)).toEqual(["app/entry.ts", "app/package.json"])
    expect(outcome.result.unresolved).toEqual([{ file: "app/entry.ts", specifier: "#x" }])
  })

  it("selects conditions in declaration order, skipping unusable and inactive ones", async () => {
    await write(
      "package.json",
      JSON.stringify({
        imports: {
          "lib/*": "./decoy/*.ts",
          "#later": { node: { browser: "./browser.ts" }, default: "./later.ts" },
          "#nothing": [null, { browser: "./browser.ts" }],
          "#number": 42,
          "#null/*": null,
          "#deep8": nested(8, "./deep.ts"),
          "#deep9": nested(9, "./deep.ts")
        }
      })
    )
    await write("later.ts", `export const later = 1\n`)
    await write("deep.ts", `export const deep = 1\n`)
    await write("browser.ts", `export const browser = 1\n`)
    const resolve = await resolver()
    await expect(resolve("#later")).resolves.toEqual({
      specifier: "#later",
      status: "resolved-file",
      resolved: "later.ts"
    })
    await expect(resolve("#deep8")).resolves.toEqual({
      specifier: "#deep8",
      status: "resolved-file",
      resolved: "deep.ts"
    })
    for (const specifier of ["#nothing", "#number", "#null/x", "#deep9", "#lib/x"]) {
      await expect(resolve(specifier)).resolves.toEqual({ specifier, status: "unresolved" })
    }
  })

  it("never resolves an #imports target for an importer spelled through the workspace parent", async () => {
    await write("sub/package.json", JSON.stringify({ imports: { "#lib": "./lib.ts" } }))
    await write("sub/lib.ts", `export const lib = 1\n`)
    const fromFile = `../${NodePath.basename(root)}/sub/entry.ts`
    const resolve = await resolver(fromFile)
    await expect(resolve("#lib")).resolves.toEqual({ specifier: "#lib", status: "unresolved" })
    const normal = await resolver("sub/entry.ts")
    await expect(normal("#lib")).resolves.toEqual({
      specifier: "#lib",
      status: "resolved-file",
      resolved: "sub/lib.ts"
    })
  })
})

describe("tree classification edges", () => {
  it("classifies linked directories as directories and links to devices as neither file nor directory", async () => {
    await write("real/index.ts", `export const real = 1\n`)
    await Fs.symlink("real", NodePath.join(root, "linked"))
    await Fs.symlink("/dev/null", NodePath.join(root, "device.ts"))
    await write("entry.ts", `import "./linked"\nimport "./device"\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["entry.ts", "linked/index.ts"])
    expect(outcome.result.unresolved).toEqual([{ file: "entry.ts", specifier: "./device" }])
  })

  it("never resolves a FIFO named like a module", async () => {
    await promisify(execFile)("mkfifo", [NodePath.join(root, "pipe.ts")])
    await write("entry.ts", `import "./pipe"\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["entry.ts"])
    expect(outcome.result.unresolved).toEqual([{ file: "entry.ts", specifier: "./pipe" }])
  })

  it("resolves an extensionless file literally and leaves index-less directories and missing .js unresolved", async () => {
    await write("LICENSE", "MIT\n")
    await Fs.mkdir(NodePath.join(root, "empty"))
    await write("entry.ts", `import "./LICENSE"\nimport "./empty"\nimport "./missing.js"\n`)
    const outcome = await closureOf(["entry.ts"])
    expect(paths(outcome)).toEqual(["LICENSE", "entry.ts"])
    expect(outcome.result.unresolved).toEqual([
      { file: "entry.ts", specifier: "./empty" },
      { file: "entry.ts", specifier: "./missing.js" }
    ])
  })

  it("leaves a query-only specifier unresolved", async () => {
    const resolve = await resolver()
    await expect(resolve("?raw")).resolves.toEqual({ specifier: "?raw", status: "unresolved" })
  })
})
