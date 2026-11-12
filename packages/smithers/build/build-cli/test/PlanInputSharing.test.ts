import fsPromises, * as Fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import type * as Reporter from "../src/Reporter.ts"

const roots: Array<string> = []

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const workspace = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-plan-input-sharing-")))
  roots.push(root)
  const all: Record<string, string> = {
    "package.json": "{\"name\":\"plan-input-sharing\",\"private\":true,\"type\":\"module\"}\n",
    "WORKSPACE.ts": `import { Smithers as S } from "@smthrs/targets"
const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const Workspace = S.Workspace("plan-input-sharing", {
  repository: "git+https://example.invalid/plan-input-sharing.git",
  cache: S.Cache({ directory: ".flows" }), runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})\n`,
    ...files
  }
  for (const [relative, contents] of Object.entries(all)) {
    const path = Path.join(root, relative)
    await Fs.mkdir(Path.dirname(path), { recursive: true })
    await Fs.writeFile(path, contents)
  }
  return root
}

const planOf = async (root: string, patterns: ReadonlyArray<string>) =>
  PackageExec.plan({
    index: PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root))),
    patterns: [...patterns],
    cacheDirectory: ".flows",
    verb: "test"
  })

/** One compiler-style suite: `count` tests, each reading its own case and every case's shared helpers. */
const suite = (count: number): Record<string, string> => {
  const files: Record<string, string> = { "cases/helper.mjs": "export {}\n" }
  const targets: Array<string> = []
  for (let index = 0; index < count; index += 1) {
    files[`cases/c${index}/input.txt`] = `case ${index}\n`
    targets.push(`c${index}: S.Shell.Test({
  summary: "One case.",
  shell: "true",
  data: [S.file("cases/helper.mjs"), S.glob("cases/*.mjs"), S.glob("cases/c${index}/**")],
  sandbox: "none"
})`)
  }
  files["PACKAGE.ts"] = `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {\n${targets.join(",\n")}\n} })\n`
  return files
}

/** How many times one plan of `root` opens each directory, by workspace-relative path. */
const directoryOpens = async (root: string, patterns: ReadonlyArray<string>): Promise<Map<string, number>> => {
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
  const opens = new Map<string, number>()
  const original = fsPromises.opendir
  vi.spyOn(fsPromises, "opendir").mockImplementation((path, options) => {
    const relative = Path.relative(root, String(path))
    opens.set(relative, (opens.get(relative) ?? 0) + 1)
    return original(path, options)
  })
  syncBuiltinESMExports()
  await PackageExec.plan({ index, patterns: [...patterns], cacheDirectory: ".flows", verb: "test" })
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  return opens
}

const inputsOf = (
  node:
    | { readonly declaredInputs: ReadonlyArray<{ readonly files: ReadonlyArray<{ readonly path: string }> }> }
    | undefined
) => node?.declaredInputs.flatMap((input) => input.files.map((file) => file.path)).sort()

describe("one plan reads a shared declared input once", () => {
  it.skipIf(process.platform === "win32")("walks a glob's tree once however many targets declare it", async () => {
    const few = await directoryOpens(await workspace(suite(40)), ["//:c0", "//:c1"])
    const many = await directoryOpens(await workspace(suite(40)), ["//..."])
    // `cases/*.mjs` starts at `cases`, so its walk opens every case directory.
    // Case 20's own glob reuses that listing: planning all 40 targets opens
    // no directory that planning two did not.
    expect(many.get("cases/c20")).toBe(few.get("cases/c20"))
    expect(Math.max(...many.values())).toBe(Math.max(...few.values()))
  })

  it("gives every target that shares a glob the rows the glob names", async () => {
    const root = await workspace(suite(3))
    const plan = await planOf(root, ["//..."])
    for (const name of ["c0", "c1", "c2"]) {
      expect(inputsOf(plan.nodes.get(`//:${name}`))).toEqual([
        `cases/${name}/input.txt`,
        "cases/helper.mjs",
        "cases/helper.mjs"
      ])
    }
  })

  it("hands every target sharing a glob the same rows, which nothing can change", async () => {
    const root = await workspace(suite(3))
    const plan = await planOf(root, ["//..."])
    // Keys reuse the encoding of rows that cannot change; a row that could be
    // edited after one key was taken would make the next key stale.
    const shared = ["c0", "c1", "c2"].map((name) =>
      plan.nodes.get(`//:${name}`)!.declaredInputs.find((input) =>
        input.files.length === 1 && input.files[0]!.path === "cases/helper.mjs" && input.declaration._tag === "Glob"
      )!.files
    )
    expect(shared[1]).toBe(shared[0])
    expect(shared[2]).toBe(shared[0])
    expect(Object.isFrozen(shared[0])).toBe(true)
    expect(Object.isFrozen(shared[0]![0])).toBe(true)
    for (const node of plan.nodes.values()) {
      for (const input of node.declaredInputs) {
        expect(Object.isFrozen(input.files)).toBe(true)
        for (const row of input.files) expect(Object.isFrozen(row)).toBe(true)
      }
    }
  })

  it("keeps one target's key when another target starts sharing its inputs", async () => {
    const root = await workspace(suite(3))
    const alone = await planOf(root, ["//:c1"])
    const together = await planOf(root, ["//..."])
    expect(together.nodes.get("//:c1")?.keyPreview).toBe(alone.nodes.get("//:c1")?.keyPreview)
  })

  it("keeps the same pattern apart in two packages", async () => {
    const packageWith = `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  test: S.Shell.Test({ summary: "One.", shell: "true", data: [S.glob("src/*.txt")], sandbox: "none" })
} })\n`
    const root = await workspace({
      "a/PACKAGE.ts": packageWith,
      "a/src/only-a.txt": "a\n",
      "b/PACKAGE.ts": packageWith,
      "b/src/only-b.txt": "b\n"
    })
    const plan = await planOf(root, ["//..."])
    expect(inputsOf(plan.nodes.get("//a:test"))).toEqual(["a/src/only-a.txt"])
    expect(inputsOf(plan.nodes.get("//b:test"))).toEqual(["b/src/only-b.txt"])
  })

  it("keeps one pattern apart under different exclusions", async () => {
    const root = await workspace({
      "PACKAGE.ts": `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  all: S.Shell.Test({ summary: "All.", shell: "true", data: [S.glob("src/*.txt")], sandbox: "none" }),
  some: S.Shell.Test({
    summary: "Some.",
    shell: "true",
    data: [S.glob("src/*.txt", { exclude: ["src/b.txt"] })],
    sandbox: "none"
  })
} })\n`,
      "src/a.txt": "a\n",
      "src/b.txt": "b\n"
    })
    const plan = await planOf(root, ["//..."])
    expect(inputsOf(plan.nodes.get("//:all"))).toEqual(["src/a.txt", "src/b.txt"])
    expect(inputsOf(plan.nodes.get("//:some"))).toEqual(["src/a.txt"])
  })

  it("reads the tree again for the next plan", async () => {
    const root = await workspace(suite(2))
    const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
    const planned = () => PackageExec.plan({ index, patterns: ["//:c0"], cacheDirectory: ".flows", verb: "test" })
    const before = await planned()
    await Fs.writeFile(Path.join(root, "cases/helper.mjs"), "export const changed = true\n")
    const after = await planned()
    expect(after.nodes.get("//:c0")?.keyPreview).not.toBe(before.nodes.get("//:c0")?.keyPreview)
  })
})

/** Serves one CLI invocation in-process and counts directory opens by workspace-relative path. */
const servedDirectoryOpens = async (root: string, args: ReadonlyArray<string>): Promise<Map<string, number>> => {
  const opens = new Map<string, number>()
  const original = fsPromises.opendir
  vi.spyOn(fsPromises, "opendir").mockImplementation((path, options) => {
    const relative = Path.relative(root, String(path))
    opens.set(relative, (opens.get(relative) ?? 0) + 1)
    return original(path, options)
  })
  syncBuiltinESMExports()
  let output = ""
  let exitCode = 0
  const terminal = (): Reporter.Terminal => ({ write: (text) => (output += text), isTTY: false, columns: 100 })
  try {
    await makeCli({
      environment: { ...process.env, SMITHERS_AUDIENCE: "agent", NO_COLOR: "1", CI: undefined },
      stdout: terminal(),
      stderr: terminal()
    }).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => (exitCode = code),
      stdout: (text) => (output += text)
    })
  } finally {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
  }
  expect(exitCode, output).toBe(0)
  return opens
}

describe("smthrs ci plans its verbs over one walk of each glob", () => {
  it.skipIf(process.platform === "win32")("walks a glob two verbs reach as often as one verb's plan does", async () => {
    const root = await workspace({
      "PACKAGE.ts": `import { Smithers as S } from "@smthrs/targets"
const tree = S.Filegroup({ srcs: [S.glob("src/**")] })
export const Package = S.Package({ targets: {
  tree,
  built: S.Shell.Build({ summary: "Built.", shell: "true", data: [tree], outFiles: ["out/built.txt"], sandbox: "none" }),
  tested: S.Shell.Test({ summary: "Tested.", shell: "true", data: [tree], sandbox: "none" })
} })\n`,
      "src/a.txt": "a\n",
      "src/nested/b.txt": "b\n"
    })
    const one = await servedDirectoryOpens(root, ["test", "//...", "--plan", "--format", "json"])
    const all = await servedDirectoryOpens(root, ["ci", "//...", "--plan", "--format", "json"])
    // Discovery opens each directory once too; planning adds one walk.
    expect(one.get("src")).toBe(2)
    expect(all.get("src")).toBe(one.get("src"))
    expect(all.get("src/nested")).toBe(one.get("src/nested"))
  })
})
