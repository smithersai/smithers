import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { computeClosure, loadResolverConfig } from "../src/Resolver.ts"

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

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-resolver-dirs-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("directory specifiers", () => {
  it("resolves \".\" in a root module to the workspace root index", async () => {
    await write("main.ts", `import "."\n`)
    await write("index.ts", `export const index = 1\n`)
    const outcome = await closureOf(["main.ts"])
    expect(outcome.result.unresolved).toEqual([])
    expect(paths(outcome)).toEqual(["index.ts", "main.ts"])
  })

  it("resolves \"..\" from a top-level directory to the workspace root index", async () => {
    await write("src/main.ts", `import ".."\n`)
    await write("index.js", `export const index = 1\n`)
    const outcome = await closureOf(["src/main.ts"])
    expect(outcome.result.unresolved).toEqual([])
    expect(paths(outcome)).toEqual(["index.js", "src/main.ts"])
  })

  it("resolves \"./\" in a root module to the root index, never a dotfile named like an extension", async () => {
    await write("main.ts", `import "./"\n`)
    await write(".ts", `export const decoy = 1\n`)
    await write("index.tsx", `export const index = 1\n`)
    const outcome = await closureOf(["main.ts"])
    expect(outcome.result.unresolved).toEqual([])
    expect(paths(outcome)).toEqual(["index.tsx", "main.ts"])
  })

  it("resolves a trailing-slash specifier to the directory index only, as the compiler does", async () => {
    await write("main.ts", `import "./lib/"\n`)
    await write("lib.ts", `export const sibling = 1\n`)
    await write("lib/.ts", `export const decoy = 1\n`)
    await write("lib/index.ts", `export const lib = 1\n`)
    const outcome = await closureOf(["main.ts"])
    expect(outcome.result.unresolved).toEqual([])
    expect(paths(outcome)).toEqual(["lib/index.ts", "main.ts"])
  })

  it("keeps the root and a trailing-slash directory without an index unresolved", async () => {
    await write("main.ts", `import "."\nimport "./lib/"\nimport "./missing/"\n`)
    await write("lib/readme.md", "no index\n")
    const outcome = await closureOf(["main.ts"])
    expect(paths(outcome)).toEqual(["main.ts"])
    expect(outcome.result.unresolved).toEqual([
      { file: "main.ts", specifier: "." },
      { file: "main.ts", specifier: "./lib/" },
      { file: "main.ts", specifier: "./missing/" }
    ])
  })
})
