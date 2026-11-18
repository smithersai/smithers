/**
 * `new URL(path, import.meta.url)` reference sites and the per-file rows a
 * closure hands back, over real trees in a temporary directory.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openCache } from "../src/Cache.ts"
import { computeClosure, extractSpecifiers, type FileRow, loadResolverConfig } from "../src/Resolver.ts"
import { write as writeUnder } from "./helpers/WriteFile.ts"

let root: string
const write = (relative: string, text: string): Promise<void> => writeUnder(root, relative, text)

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-resolver-references-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const closureOf = async (entries: ReadonlyArray<string>, references = true, rows?: Map<string, FileRow>) => {
  const config = await loadResolverConfig({ workspaceRoot: root })
  return (await computeClosure({ config, entries, references, rows })).result
}

describe("extractSpecifiers", () => {
  it("extracts new URL(path, import.meta.url) as a reference site", () => {
    expect(extractSpecifiers(
      "a.ts",
      [
        `const a = new URL("./a.txt", import.meta.url)`,
        "const b = new URL(`../b.txt`, import.meta.url).href",
        `const c = new URL(name, import.meta.url)`,
        "const d = new URL(`./${name}.txt`, import.meta.url)"
      ].join("\n")
    )).toEqual([
      { specifier: "./a.txt", dynamic: false, mode: "reference" },
      { specifier: "../b.txt", dynamic: false, mode: "reference" },
      { specifier: "name", dynamic: true, mode: "reference" },
      { specifier: "`./${name}.txt`", dynamic: true, mode: "reference" }
    ])
  })

  it("leaves every other URL construction alone", () => {
    expect(extractSpecifiers(
      "a.ts",
      [
        `new URL("https://example.invalid/")`,
        `new URL("./a.txt", base)`,
        `new URL("./a.txt", import.meta.dirname)`,
        `new URL("./a.txt", other.meta.url)`,
        `new URL("./a.txt", import.meta.url, extra)`,
        `new Other("./a.txt", import.meta.url)`,
        `new lib.URL("./a.txt", import.meta.url)`,
        `URL("./a.txt", import.meta.url)`,
        `new URL`,
        `function f() { return new URL("./a.txt", new.target.url) }`
      ].join("\n")
    )).toEqual([])
  })
})

describe("a closure that follows references", () => {
  it("follows a referenced file and what it imports, only when asked", async () => {
    await write("test/a.test.ts", `const main = new URL("../src/main.js?x=1#top", import.meta.url)\n`)
    await write("src/main.js", `import "./dep.js"\n`)
    await write("src/dep.js", "export {}\n")
    const followed = await closureOf(["test/a.test.ts"])
    expect(followed.files.map((file) => file.path)).toEqual(["src/dep.js", "src/main.js", "test/a.test.ts"])
    expect(followed.unresolved).toEqual([])
    expect(followed.dynamic).toEqual([])
    const ignored = await closureOf(["test/a.test.ts"], false)
    expect(ignored.files.map((file) => file.path)).toEqual(["test/a.test.ts"])
  })

  it("resolves a path with no leading dot against the file's directory", async () => {
    await write("a.ts", `new URL("data.json", import.meta.url)\n`)
    await write("data.json", "{}\n")
    expect((await closureOf(["a.ts"])).files.map((file) => file.path)).toEqual(["a.ts", "data.json"])
  })

  it("calls a directory, however it is spelled, and a computed path dynamic", async () => {
    await write(
      "pkg/test/a.test.ts",
      [
        `new URL("../", import.meta.url)`,
        `new URL("../src", import.meta.url)`,
        `new URL("../../", import.meta.url)`,
        `new URL("../node_modules", import.meta.url)`,
        `new URL("../node_modules/@scope", import.meta.url)`,
        `new URL(name, import.meta.url)`
      ].join("\n")
    )
    await write("pkg/src/x.ts", "export {}\n")
    await write("pkg/node_modules/@scope/lib/index.js", "export {}\n")
    const closure = await closureOf(["pkg/test/a.test.ts"])
    expect(closure.files.map((file) => file.path)).toEqual(["pkg/test/a.test.ts"])
    expect(closure.dynamic.map((issue) => issue.specifier)).toEqual([
      "../",
      "../../",
      "../node_modules",
      "../node_modules/@scope",
      "../src",
      "name"
    ])
    expect(closure.unresolved).toEqual([])
  })

  it("reads a file inside an install as its package and never walks into it", async () => {
    await write(
      "pkg/test/a.test.ts",
      [
        `new URL("../node_modules/tool/bin.mjs", import.meta.url)`,
        `new URL("../node_modules/@scope/lib/dist/index.js", import.meta.url)`
      ].join("\n")
    )
    await write("pkg/node_modules/tool/bin.mjs", `import "./missing.js"\n`)
    await write("pkg/node_modules/@scope/lib/dist/index.js", "export {}\n")
    const closure = await closureOf(["pkg/test/a.test.ts"])
    expect(closure.files.map((file) => file.path)).toEqual(["pkg/test/a.test.ts"])
    expect(closure.packages).toEqual(["@scope/lib", "tool"])
    expect(closure.unresolved).toEqual([])
  })

  it("leaves a reference it cannot follow to a workspace file unresolved", async () => {
    await write(
      "test/a.test.ts",
      [
        `new URL("./missing.txt", import.meta.url)`,
        `new URL("/etc/hosts", import.meta.url)`,
        `new URL("file:///etc/hosts", import.meta.url)`,
        `new URL("..\\\\src\\\\a.ts", import.meta.url)`,
        `new URL("../../outside.txt", import.meta.url)`
      ].join("\n")
    )
    const closure = await closureOf(["test/a.test.ts"])
    expect(closure.unresolved.map((issue) => issue.specifier)).toEqual([
      "../../outside.txt",
      "..\\src\\a.ts",
      "./missing.txt",
      "/etc/hosts",
      "file:///etc/hosts"
    ])
    expect(closure.dynamic).toEqual([])
  })

  it("stores reference sites in cached rows and reads them back", async () => {
    await write("a.ts", `new URL("./b.ts", import.meta.url)\n`)
    await write("b.ts", "export {}\n")
    const cache = await openCache({ workspaceRoot: root, cacheDirectory: ".flows" })
    try {
      const config = await loadResolverConfig({ workspaceRoot: root })
      const cold = await computeClosure({ config, entries: ["a.ts"], cache, references: true })
      const warm = await computeClosure({ config, entries: ["a.ts"], cache, references: true })
      expect(cold.stats).toEqual({ parsed: 2, cached: 0 })
      expect(warm.stats).toEqual({ parsed: 0, cached: 2 })
      expect(warm.result).toEqual(cold.result)
      expect(warm.result.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"])
    } finally {
      await cache.close()
    }
  })
})

describe("the rows of one walk", () => {
  it("hands back one row per reached file, with every edge it resolved", async () => {
    await write("package.json", `${JSON.stringify({ name: "rows", imports: { "#lib": "./lib.ts" } })}\n`)
    await write(
      "a.ts",
      `import "#lib"\nimport "./data.json"\nimport "node:fs"\nimport "./gone.ts"\nawait import(name)\n`
    )
    await write("b.ts", `import "#lib"\n`)
    await write("lib.ts", "export {}\n")
    await write("data.json", "{}\n")
    const rows = new Map<string, FileRow>()
    const closure = await closureOf(["a.ts", "b.ts"], true, rows)
    expect([...rows.keys()].sort()).toEqual(closure.files.map((file) => file.path))
    expect([...rows.keys()].sort()).toEqual(["a.ts", "b.ts", "data.json", "lib.ts", "package.json"])
    for (const file of closure.files) expect(rows.get(file.path)!.digest).toBe(file.digest)
    expect(rows.get("a.ts")!.edges).toEqual([
      { specifier: "#", status: "resolved-file", resolved: "package.json" },
      { specifier: "#lib", status: "resolved-file", resolved: "lib.ts" },
      { specifier: "./data.json", status: "resolved-file", resolved: "data.json" },
      { specifier: "node:fs", status: "builtin" },
      { specifier: "./gone.ts", status: "unresolved" },
      { specifier: "name", status: "dynamic" }
    ])
    expect(rows.get("b.ts")!.edges.map((edge) => edge.resolved)).toEqual(["package.json", "lib.ts"])
    expect(rows.get("data.json")!.edges).toEqual([])
    expect(rows.get("package.json")!.edges).toEqual([])
  })
})
