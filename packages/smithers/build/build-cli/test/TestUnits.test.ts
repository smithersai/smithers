/**
 * Test units over real workspaces: real files, a real git repository, the
 * real loader and CLI, and real child processes. The package manager a
 * fixture declares is a small program that stands in for `pnpm exec vitest`:
 * it writes the blob a unit run writes and exits as the test file says.
 */
import { Smithers as S } from "@smthrs/targets"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import { makeCli, normalizeArgv, openPackageIndex } from "../src/Cli.ts"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as TestUnits from "../src/TestUnits.ts"
import { writeExecutable } from "./helpers/Executable.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const commit = (root: string): void => {
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "change")
}

/**
 * Stands in for `pnpm exec vitest`. A unit run writes its blob unless the
 * test file says NOBLOB, and fails when it says FAIL. A merge fails when a
 * blob says UNCOVERED. Every invocation is appended to `UNITS_LOG`.
 */
const manager = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.UNITS_LOG, JSON.stringify(args) + "\\n")
const merge = args.find((arg) => arg.startsWith("--merge-reports="))
if (merge !== undefined) {
  const directory = merge.slice("--merge-reports=".length)
  const blobs = fs.readdirSync(directory).filter((name) => name.endsWith(".blob")).sort()
  console.log("merged " + blobs.length)
  const uncovered = blobs.some((name) => fs.readFileSync(path.join(directory, name), "utf8").includes("UNCOVERED"))
  if (uncovered) console.error("ERROR: Coverage for lines does not meet threshold")
  process.exit(uncovered ? 1 : 0)
}
const file = args[args.indexOf("--reporter=default") - 1]
const text = fs.readFileSync(file, "utf8")
const blob = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length)
if (!text.includes("NOBLOB")) fs.writeFileSync(blob, text)
if (text.includes("FAIL")) {
  console.error("AssertionError: expected 1 to be 2 in " + file)
  process.exit(1)
}
`

interface Fixture {
  readonly root: string
  readonly log: string
  readonly index: () => Promise<PackageIndex>
  readonly invocations: () => Promise<ReadonlyArray<ReadonlyArray<string>>>
}

const target = "//pkg:test"

/**
 * A committed workspace. `pkg` holds a Vitest target split by file: `a` and
 * `b` reach `shared`, `c` reaches only its own source, `lib` reads the
 * dependency's files. `notes` belongs to another target.
 */
const fixture = async (options: { readonly tests?: string; readonly extra?: string } = {}): Promise<Fixture> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-test-units-")))
  temporaryDirectories.push(root)
  const tools = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-test-units-tools-")))
  temporaryDirectories.push(tools)
  const pnpm = await writeExecutable(NodePath.join(tools, "pnpm"), manager)
  const log = NodePath.join(tools, "invocations.log")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("units", {
  repository: "git+https://example.invalid/units.git",
  cache: S.Cache({ directory: ".flows" })
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const notes = S.Filegroup({ srcs: [S.glob("notes/**")] })
export const Package = S.Package({ targets: { notes } })
`
  )
  await write(
    root,
    "pkg/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const runtime = S.Runtime.Node({ version: ">=26.4.0" })
const lib = S.Filegroup({ srcs: [S.glob("lib/**")] })
const whole = S.Vitest({
  tests: [S.glob("test/**/*.test.ts")],
  sources: [],
  deps: [],
  config: null,
  environment: "node",
  passWithNoTests: false
})
const test = S.Vitest({
  tests: [${options.tests ?? `S.glob("test/**/*.test.ts", { exclude: ["test/skipped/**"] })`}],
  sources: [S.glob("src/**/*.ts"), S.glob("data/**")],
  deps: [lib],
  config: S.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  units: "file",
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", executable: ${JSON.stringify(pnpm)}, runtime }),
  env: { UNITS_LOG: ${JSON.stringify(log)}, UNITS_FIXTURE: "1" },
  cwd: "pkg"
})
${options.extra ?? ""}
export const Package = S.Package({ targets: { lib, test, whole${options.extra === undefined ? "" : ", extra"} } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "units", private: true })}\n`)
  await write(root, ".gitignore", ".flows\n")
  await write(root, "notes/readme.txt", "notes\n")
  await write(
    root,
    "pkg/vitest.config.ts",
    `export default { test: { setupFiles: [new URL("./setup.ts", import.meta.url).pathname] } }\n`
  )
  await write(root, "pkg/setup.ts", "export {}\n")
  await write(root, "pkg/src/shared.ts", "export const shared = 1\n")
  await write(root, "pkg/src/a.ts", `import { shared } from "./shared.ts"\nexport const a = shared\n`)
  await write(root, "pkg/src/b.ts", `import { shared } from "./shared.ts"\nexport const b = shared\n`)
  await write(root, "pkg/src/c.ts", "export const c = 3\n")
  await write(root, "pkg/src/unreached.ts", "export const unreached = 0\n")
  await write(root, "pkg/data/fixture.json", "{}\n")
  await write(root, "pkg/lib/out.js", "export const out = 1\n")
  await write(root, "pkg/lib/other.js", "export const other = 1\n")
  // `shared` is reached twice from this file: directly, and through `a`.
  await write(
    root,
    "pkg/test/a.test.ts",
    `import { a } from "../src/a.ts"\nimport "../src/shared.ts"\nexport const test = a\n`
  )
  await write(root, "pkg/test/b.test.ts", `import { b } from "../src/b.ts"\nexport const test = b\n`)
  await write(root, "pkg/test/c.test.ts", `import { c } from "../src/c.ts"\nexport const test = c\n`)
  await write(root, "pkg/test/lib.test.ts", `import { out } from "../lib/out.js"\nexport const test = out\n`)
  await write(root, "pkg/test/skipped/never.test.ts", "export {}\n")
  git(root, "init", "-q")
  commit(root)
  return {
    root,
    log,
    index: () => openPackageIndex({ workspace: root }),
    invocations: async () =>
      (await Fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) =>
        JSON.parse(line) as ReadonlyArray<string>
      )
  }
}

const unitsOf = async (workspace: Fixture): Promise<TestUnits.Units> =>
  TestUnits.discover({ index: await workspace.index(), target, cacheDirectory: ".flows" })

/** The unit labels a set of changed files selects, each with its reason kinds. */
const selected = async (
  workspace: Fixture,
  files: ReadonlyArray<string>
): Promise<Record<string, ReadonlyArray<string>>> => {
  const index = await workspace.index()
  const units = await TestUnits.discover({ index, target, cacheDirectory: ".flows" })
  const change = TestUnits.changeOf(index, units, files, { cacheDirectory: ".flows" })
  return Object.fromEntries(
    TestUnits.select(units, change).map(({ reasons, unit }) => [
      unit.label.slice(target.length + 1),
      reasons.map((reason) => reason.kind)
    ])
  )
}

describe("unit labels", () => {
  it("joins a target and a test file and reads them back", () => {
    const unit = TestUnits.label("//pkg:test", "pkg", "pkg/test/a.test.ts")
    expect(unit).toBe("//pkg:test#test/a.test.ts")
    expect(TestUnits.parse(unit)).toEqual({ target: "//pkg:test", packagePath: "pkg", file: "pkg/test/a.test.ts" })
  })

  it("names a file of the root package and a file outside the package", () => {
    expect(TestUnits.label("//:test", "", "test/a.test.ts")).toBe("//:test#test/a.test.ts")
    expect(TestUnits.parse("//:test#test/a.test.ts")).toEqual({
      target: "//:test",
      packagePath: "",
      file: "test/a.test.ts"
    })
    const outside = TestUnits.label("//pkg:test", "pkg", "other/x.test.ts")
    expect(outside).toBe("//pkg:test#//other/x.test.ts")
    expect(TestUnits.parse(outside)?.file).toBe("other/x.test.ts")
  })

  it("keeps a # inside the file path", () => {
    expect(TestUnits.parse("//pkg:test#test/c#.test.ts")?.file).toBe("pkg/test/c#.test.ts")
  })

  it.each(["//pkg:test", "//pkg:test#", "pkg:test#a.ts", "//pkg#a.ts", "//pkg:test#//"])(
    "reads %s as no unit",
    (text) => {
      expect(TestUnits.parse(text)).toBeUndefined()
    }
  )
})

describe("discover", () => {
  it("reads one unit per test file with what each reaches and what all share", async () => {
    const workspace = await fixture()
    const units = await unitsOf(workspace)
    expect(units.target).toBe(target)
    expect(units.packagePath).toBe("pkg")
    expect(units.dependencies).toEqual(["//pkg:lib"])
    expect(units.units.map((unit) => unit.label)).toEqual([
      "//pkg:test#test/a.test.ts",
      "//pkg:test#test/b.test.ts",
      "//pkg:test#test/c.test.ts",
      "//pkg:test#test/lib.test.ts"
    ])
    const [a, b, c, lib] = units.units as [TestUnits.Unit, TestUnits.Unit, TestUnits.Unit, TestUnits.Unit]
    expect(a.reached.map((file) => file.path)).toEqual(["pkg/src/a.ts", "pkg/src/shared.ts", "pkg/test/a.test.ts"])
    expect(c.reached.map((file) => file.path)).toEqual(["pkg/src/c.ts", "pkg/test/c.test.ts"])
    expect(a.reached[0]!.digest).toMatch(/^[0-9a-f]{64}$/)
    // The config, the setup file it references, and each declared input no test reaches.
    expect(units.shared.map((file) => file.path)).toEqual([
      "pkg/data/fixture.json",
      "pkg/setup.ts",
      "pkg/src/unreached.ts",
      "pkg/vitest.config.ts"
    ])
    // Only the unit that reads the dependency's files depends on it.
    expect([a, b, c, lib].map((unit) => unit.dependencies)).toEqual([[], [], [], ["//pkg:lib"]])
    expect(new Set(units.units.map((unit) => unit.key)).size).toBe(4)
  })

  it("gives a contract 9 closure that holds the reached and the shared files", async () => {
    const workspace = await fixture()
    const units = await unitsOf(workspace)
    const closure = TestUnits.closure(units, units.units[2]!)
    expect(closure).toEqual({
      strategy: "typescript",
      entries: ["pkg/test/c.test.ts"],
      files: [
        "pkg/data/fixture.json",
        "pkg/setup.ts",
        "pkg/src/c.ts",
        "pkg/src/unreached.ts",
        "pkg/test/c.test.ts",
        "pkg/vitest.config.ts"
      ].map((path) => ({ path, digest: expect.stringMatching(/^[0-9a-f]{64}$/) })),
      packages: [],
      unresolved: [],
      dynamic: []
    })
  })

  it("re-keys only the units that reach an edited file, and every unit for a shared one", async () => {
    const workspace = await fixture()
    const keys = async () =>
      Object.fromEntries((await unitsOf(workspace)).units.map((unit) => [unit.file.slice(9), unit.key]))
    const before = await keys()
    expect(await keys()).toEqual(before)
    await write(workspace.root, "pkg/src/shared.ts", "export const shared = 2\n")
    const edited = await keys()
    expect(edited["a.test.ts"]).not.toBe(before["a.test.ts"])
    expect(edited["b.test.ts"]).not.toBe(before["b.test.ts"])
    expect(edited["c.test.ts"]).toBe(before["c.test.ts"])
    expect(edited["lib.test.ts"]).toBe(before["lib.test.ts"])
    await write(workspace.root, "pkg/data/fixture.json", `{"changed":true}\n`)
    const shared = await keys()
    for (const name of Object.keys(before)) expect(shared[name]).not.toBe(edited[name])
  })

  it("puts an import the config cannot follow on every unit", async () => {
    const workspace = await fixture()
    await write(
      workspace.root,
      "pkg/vitest.config.ts",
      `import "./missing.ts"\nconst name = "x"\nawait import(name)\nexport default {}\n`
    )
    const units = await unitsOf(workspace)
    for (const unit of units.units) {
      expect(unit.unresolved).toEqual([{ from: "pkg/vitest.config.ts", specifier: "./missing.ts" }])
      expect(unit.dynamic).toEqual([{ from: "pkg/vitest.config.ts", specifier: "name" }])
    }
  })

  it("reads a target with no config and no package tsconfig", async () => {
    const workspace = await fixture({
      extra: `const extra = S.Vitest({
  tests: [S.file("test/a.test.ts")],
  sources: [S.gitDiff("HEAD")],
  deps: [S.Filegroup({ srcs: [S.glob("lib/**")] })],
  config: null,
  environment: "node",
  passWithNoTests: false,
  units: "file"
})`
    })
    // A declared input that is neither a file nor a glob names no file to share,
    // and a dependency the package does not export has no label to read by.
    const units = await TestUnits.discover({ index: await workspace.index(), target: "//pkg:extra" })
    expect(units.units.map((unit) => unit.label)).toEqual(["//pkg:extra#test/a.test.ts"])
    expect(units.shared).toEqual([])
    expect(units.dependencies).toEqual([])
  })

  it("resolves an alias through the package's own tsconfig", async () => {
    const workspace = await fixture()
    await write(
      workspace.root,
      "pkg/tsconfig.json",
      `${JSON.stringify({ compilerOptions: { paths: { "@src/*": ["./src/*"] } } })}\n`
    )
    await write(workspace.root, "pkg/test/c.test.ts", `import { c } from "@src/c.ts"\nexport const test = c\n`)
    const units = await unitsOf(workspace)
    expect(units.units[2]!.reached.map((file) => file.path)).toEqual(["pkg/src/c.ts", "pkg/test/c.test.ts"])
    expect(units.units[2]!.unresolved).toEqual([])
  })

  it("refuses a label that names no target, several targets, or a target that is one unit", async () => {
    const workspace = await fixture()
    const index = await workspace.index()
    await expect(TestUnits.discover({ index, target: "//pkg/..." })).rejects.toMatchObject({
      _tag: "smithers-build/UnitsError",
      reason: "not_one_target",
      message: "//pkg/... names 3 targets; units reads exactly one"
    })
    await expect(TestUnits.discover({ index, target: "//pkg:lib" })).rejects.toMatchObject({
      reason: "not_units",
      message: `//pkg:lib runs as one unit; a Vitest target declares units: "file" to split`
    })
    await expect(TestUnits.discover({ index, target: "//pkg:whole" })).rejects.toMatchObject({ reason: "not_units" })
    const empty = PackageIndex.make({
      root: workspace.root,
      workspace: S.Workspace("empty", {
        repository: "git+https://example.invalid/empty.git",
        cache: S.Cache({ directory: ".flows" })
      }),
      factory: undefined,
      packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: {} }) }]
    })
    await expect(TestUnits.discover({ index: empty, target: "//..." })).rejects.toMatchObject({
      reason: "not_one_target",
      message: "//... names 0 targets; units reads exactly one"
    })
  })

  it("refuses tests that are not files or globs", async () => {
    const workspace = await fixture({ tests: `S.gitDiff("HEAD")` })
    await expect(unitsOf(workspace)).rejects.toMatchObject({
      reason: "unsupported_input",
      message: "//pkg:test: tests must be files or globs, not GitDiff"
    })
  })
})

describe("packages a unit imports by name", () => {
  it("reads a dependency whose package the test imports by name", async () => {
    const workspace = await fixture({
      extra: `import { Package as linked } from "../linked/PACKAGE.ts"
const extra = S.Vitest({
  tests: [S.glob("named/*.test.ts")],
  sources: [],
  deps: [linked.lib],
  config: null,
  environment: "node",
  passWithNoTests: false,
  units: "file"
})`
    })
    await write(
      workspace.root,
      "linked/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const lib = S.Filegroup({ srcs: [S.glob("src/**")] })
export const Package = S.Package({ targets: { lib } })
`
    )
    await write(workspace.root, "linked/package.json", `${JSON.stringify({ name: "@fx/linked" })}\n`)
    await write(workspace.root, "linked/src/index.js", "export const linked = 1\n")
    await write(workspace.root, "pkg/node_modules/registry/package.json", `${JSON.stringify({ name: "registry" })}\n`)
    await Fs.mkdir(NodePath.join(workspace.root, "pkg/node_modules/@fx"), { recursive: true })
    await Fs.symlink("../../../linked", NodePath.join(workspace.root, "pkg/node_modules/@fx/linked"))
    await Fs.symlink(Os.tmpdir(), NodePath.join(workspace.root, "pkg/node_modules/outside"))
    await write(workspace.root, "pkg/named/linked.test.ts", `import "@fx/linked"\n`)
    // A package only its importer's own directory installs is not the workspace's.
    await write(workspace.root, "elsewhere/node_modules/deep/package.json", `${JSON.stringify({ name: "deep" })}\n`)
    await write(workspace.root, "elsewhere/uses.js", `import "deep"\n`)
    await write(workspace.root, "pkg/named/deep.test.ts", `import "../../elsewhere/uses.js"\n`)
    await write(workspace.root, "pkg/named/registry.test.ts", `import "registry"\nimport "outside"\n`)
    await write(workspace.root, "pkg/named/absent.test.ts", `import "absent"\n`)
    // The manifest alone is a global input, not the dependency's output.
    await write(workspace.root, "pkg/named/manifest.test.ts", `import "@fx/linked/package.json"\n`)
    const index = await workspace.index()
    const units = await TestUnits.discover({ index, target: "//pkg:extra" })
    expect(units.units.map((unit) => [unit.label.split("#")[1], unit.packages, unit.dependencies])).toEqual([
      ["named/absent.test.ts", [], []],
      ["named/deep.test.ts", ["deep"], []],
      ["named/linked.test.ts", ["@fx/linked"], ["//linked:lib"]],
      ["named/manifest.test.ts", ["@fx/linked"], []],
      ["named/registry.test.ts", ["outside", "registry"], []]
    ])
    expect(units.units[0]!.unresolved).toEqual([{ from: "pkg/named/absent.test.ts", specifier: "absent" }])
    // A change inside the linked package reaches the unit that imports it, and no other complete unit.
    const change = TestUnits.changeOf(index, units, ["linked/src/index.js"])
    expect(change.dependencies).toEqual(new Map([["//linked:lib", ["linked/src/index.js"]]]))
    expect(TestUnits.select(units, change).map(({ reasons, unit }) => [unit.label.split("#")[1], reasons])).toEqual([
      ["named/absent.test.ts", [{ kind: "incomplete" }]],
      ["named/linked.test.ts", [{ kind: "dependency", dependency: "//linked:lib" }]]
    ])
  })
})

describe("select", () => {
  it("runs nothing for an edit outside every closure", async () => {
    const workspace = await fixture()
    expect(await selected(workspace, ["notes/readme.txt"])).toEqual({})
    expect(await selected(workspace, [])).toEqual({})
  })

  it("runs every test file that reaches an edited shared helper, and no other", async () => {
    const workspace = await fixture()
    expect(await selected(workspace, ["pkg/src/shared.ts"])).toEqual({
      "test/a.test.ts": ["closure"],
      "test/b.test.ts": ["closure"]
    })
    expect(await selected(workspace, ["pkg/src/c.ts"])).toEqual({ "test/c.test.ts": ["closure"] })
    expect(await selected(workspace, ["pkg/test/b.test.ts", "pkg/src/c.ts"])).toEqual({
      "test/b.test.ts": ["closure"],
      "test/c.test.ts": ["closure"]
    })
  })

  it("always runs a test file with a dynamic import, whatever changed", async () => {
    const workspace = await fixture()
    await write(workspace.root, "pkg/test/dynamic.test.ts", `const name = "../src/c.ts"\nawait import(name)\n`)
    await write(workspace.root, "pkg/test/unresolved.test.ts", `import "./gone.ts"\n`)
    commit(workspace.root)
    expect(await selected(workspace, ["notes/readme.txt"])).toEqual({
      "test/dynamic.test.ts": ["incomplete"],
      "test/unresolved.test.ts": ["incomplete"]
    })
    expect(await selected(workspace, ["pkg/src/c.ts"])).toEqual({
      "test/c.test.ts": ["closure"],
      "test/dynamic.test.ts": ["incomplete"],
      "test/unresolved.test.ts": ["incomplete"]
    })
    // No change at all selects nothing, an open import included.
    expect(await selected(workspace, [])).toEqual({})
  })

  it("sees an added test file and a deleted one", async () => {
    const workspace = await fixture()
    await write(workspace.root, "pkg/test/new.test.ts", `import { c } from "../src/c.ts"\nexport const test = c\n`)
    const index = await workspace.index()
    const files = await Affected.changedPaths(workspace.root, { base: "HEAD" })
    expect(files).toEqual(["pkg/test/new.test.ts"])
    expect(await selected(workspace, files)).toEqual({ "test/new.test.ts": ["closure"] })
    const added = await TestUnits.discover({ index, target })
    expect(added.units.map((unit) => unit.label)).toContain("//pkg:test#test/new.test.ts")

    commit(workspace.root)
    await Fs.rm(NodePath.join(workspace.root, "pkg/test/new.test.ts"))
    await Fs.rm(NodePath.join(workspace.root, "pkg/test/a.test.ts"))
    const deleted = await Affected.changedPaths(workspace.root, { base: "HEAD" })
    expect(deleted).toEqual(["pkg/test/a.test.ts", "pkg/test/new.test.ts"])
    // Their units are gone and no other unit read them.
    expect((await unitsOf(workspace)).units.map((unit) => unit.label)).toEqual([
      "//pkg:test#test/b.test.ts",
      "//pkg:test#test/c.test.ts",
      "//pkg:test#test/lib.test.ts"
    ])
    expect(await selected(workspace, deleted)).toEqual({})
  })

  it("runs the importers of a deleted source file, which can no longer resolve it", async () => {
    const workspace = await fixture()
    await Fs.rm(NodePath.join(workspace.root, "pkg/src/c.ts"))
    // Nothing says who read a deleted source file, so it reaches every unit.
    expect(await selected(workspace, ["pkg/src/c.ts"])).toEqual({
      "test/a.test.ts": ["unattributed"],
      "test/b.test.ts": ["unattributed"],
      "test/c.test.ts": ["incomplete", "unattributed"],
      "test/lib.test.ts": ["unattributed"]
    })
  })

  it("runs every unit for a shared input, a global input, and a file nothing attributes", async () => {
    const workspace = await fixture()
    const all = (kind: string) => ({
      "test/a.test.ts": [kind],
      "test/b.test.ts": [kind],
      "test/c.test.ts": [kind],
      "test/lib.test.ts": [kind]
    })
    expect(await selected(workspace, ["pkg/data/fixture.json"])).toEqual(all("shared"))
    expect(await selected(workspace, ["pkg/setup.ts"])).toEqual(all("shared"))
    expect(await selected(workspace, ["pkg/vitest.config.ts"])).toEqual(all("shared"))
    expect(await selected(workspace, ["pkg/src/unreached.ts"])).toEqual(all("shared"))
    expect(await selected(workspace, ["package.json"])).toEqual(all("global"))
    await write(workspace.root, "pkg/stray.txt", "stray\n")
    expect(await selected(workspace, ["pkg/stray.txt"])).toEqual(all("unattributed"))
  })

  it("runs only the units that read an affected dependency", async () => {
    const workspace = await fixture()
    expect(await selected(workspace, ["pkg/lib/other.js"])).toEqual({ "test/lib.test.ts": ["dependency"] })
    // The file the unit imports is also in its closure.
    expect(await selected(workspace, ["pkg/lib/out.js"])).toEqual({ "test/lib.test.ts": ["closure", "dependency"] })
  })
})

describe("the build tool's own sources", () => {
  // An index over this repository, so the CLI's source directory is inside it.
  const repository = fileURLToPath(new URL("../../../../../", import.meta.url))
  const cli = "packages/smithers/build/build-cli"
  const index = () =>
    PackageIndex.make({
      root: repository,
      workspace: S.Workspace("tool", {
        repository: "git+https://example.invalid/tool.git",
        cache: S.Cache({ directory: ".flows" })
      }),
      factory: undefined,
      packages: [{
        file: `${cli}/PACKAGE.ts`,
        packagePath: cli,
        value: S.Package({
          targets: {
            other: S.Filegroup({ srcs: [S.file("src/Query.ts")] }),
            test: S.Vitest({
              tests: [S.file("test/Label.test.ts"), S.file("test/Ansi.test.ts")],
              sources: [S.file("src/Label.ts"), S.file("src/Ansi.ts")],
              deps: [],
              config: null,
              environment: "node",
              passWithNoTests: false,
              units: "file"
            })
          }
        })
      }]
    })

  it("selects every target unless the caller attributes tool sources itself", () => {
    const strict = Affected.select(index(), [`//${cli}:test`], [`${cli}/src/Label.ts`])
    expect(strict.conservative).toBe(true)
    expect(strict.globalInputs).toEqual([`${cli}/src/Label.ts`])
    const lenient = Affected.select(index(), [`//${cli}:test`], [`${cli}/src/Label.ts`], { toolSources: false })
    expect(lenient.conservative).toBe(false)
    expect(lenient.targets).toEqual([{ label: `//${cli}:test`, reasons: [`${cli}/src/Label.ts`] }])
  })

  it("reads a tool source a unit imports as that unit's source, and any other as global", async () => {
    const units = await TestUnits.discover({ index: index(), target: `//${cli}:test` })
    const kinds = (files: ReadonlyArray<string>) =>
      Object.fromEntries(
        TestUnits.select(units, TestUnits.changeOf(index(), units, files)).map(({ reasons, unit }) => [
          unit.label.split("#")[1],
          reasons.map((reason) => reason.kind)
        ])
      )
    expect(kinds([`${cli}/src/Label.ts`])).toEqual({ "test/Label.test.ts": ["closure"] })
    // Query.ts is no unit's file: a tool source, and an undeclared file beside the tests.
    expect(kinds([`${cli}/src/Query.ts`])).toEqual({
      "test/Ansi.test.ts": ["global", "unattributed"],
      "test/Label.test.ts": ["global", "unattributed"]
    })
    // A lockfile is global however the tool's sources are read.
    expect(kinds([`${cli}/src/Label.ts`, "pnpm-lock.yaml"])).toEqual({
      "test/Ansi.test.ts": ["global"],
      "test/Label.test.ts": ["global"]
    })
  })
})

describe("run", () => {
  const runOf = async (
    workspace: Fixture,
    files: ReadonlyArray<string> | "all",
    spawn?: typeof ContainedProcess.run
  ): Promise<TestUnits.RunRecord> => {
    const index = await workspace.index()
    const units = await TestUnits.discover({ index, target, cacheDirectory: ".flows" })
    const chosen = files === "all"
      ? units.units
      : TestUnits.select(units, TestUnits.changeOf(index, units, files)).map(({ unit }) => unit)
    const lines: Array<string> = []
    const record = await TestUnits.run({
      root: workspace.root,
      units,
      selected: chosen,
      cacheDirectory: ".flows",
      jobs: 2,
      ...(spawn === undefined ? { log: (line) => lines.push(line) } : { spawn })
    })
    if (spawn === undefined) expect(lines).toHaveLength(record.results.length)
    return record
  }
  const blobs = async (workspace: Fixture): Promise<ReadonlyArray<string>> =>
    (await Fs.readdir(NodePath.join(workspace.root, TestUnits.blobDirectory(".flows", target)))).sort()

  it("runs each selected unit as its own process and judges coverage once every unit has run", async () => {
    const workspace = await fixture()
    const first = await runOf(workspace, ["pkg/src/shared.ts"])
    expect(first.results.map((row) => [row.label, row.status])).toEqual([
      ["//pkg:test#test/a.test.ts", "ran"],
      ["//pkg:test#test/b.test.ts", "ran"]
    ])
    expect(first).toMatchObject({
      ok: true,
      counts: { hit: 0, ran: 2, failed: 0, skipped: 0 },
      verb: "units",
      pattern: target,
      jobs: 2,
      units: 4,
      coverage: "2 of 4 units have no stored run for their inputs"
    })
    const row = first.results[0]!
    expect(row.target).toBe("Vitest")
    expect(row.key).toMatch(/^[0-9a-f]{64}$/)
    expect(row.attempts).toEqual([{ passed: true, durationMs: row.durationMs }])
    expect(row).not.toHaveProperty("error")
    const calls = await workspace.invocations()
    expect(calls).toHaveLength(2)
    const blob = NodePath.join(workspace.root, TestUnits.blobDirectory(".flows", target), `${row.key}.blob`)
    expect(calls.find((call) => call.includes("test/a.test.ts"))).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      "--environment",
      "node",
      "test/a.test.ts",
      "--reporter=default",
      "--reporter=blob",
      `--outputFile=${blob}`,
      "--coverage.thresholds=false",
      "--coverage.reporter=text-summary",
      `--coverage.reportsDirectory=${blob.replace(/\.blob$/, ".reports")}`
    ])

    // The rest run; the target's own row merges all four blobs.
    const rest = await runOf(workspace, ["pkg/src/c.ts", "pkg/lib/out.js"])
    expect(rest.results.map((row) => [row.label, row.status])).toEqual([
      ["//pkg:test#test/c.test.ts", "ran"],
      ["//pkg:test#test/lib.test.ts", "ran"],
      ["//pkg:test", "ran"]
    ])
    expect(rest).not.toHaveProperty("coverage")
    expect(rest.counts.ran).toBe(3)
    expect((await workspace.invocations()).at(-1)).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      "--environment",
      "node",
      `--merge-reports=${NodePath.join(workspace.root, TestUnits.blobDirectory(".flows", target))}`
    ])
    expect(await blobs(workspace)).toHaveLength(4)

    // An edit reruns one unit; its old blob goes and the other three are reused.
    await write(workspace.root, "pkg/src/c.ts", "export const c = 4\n")
    const before = await blobs(workspace)
    const edited = await runOf(workspace, ["pkg/src/c.ts"])
    expect(edited.results.map((row) => row.label)).toEqual(["//pkg:test#test/c.test.ts", "//pkg:test"])
    const after = await blobs(workspace)
    expect(after).toHaveLength(4)
    expect(after.filter((name) => before.includes(name))).toHaveLength(3)

    // A run that selects nothing still drops what no current key names, a leftover report directory included.
    const directory = NodePath.join(workspace.root, TestUnits.blobDirectory(".flows", target))
    await Fs.mkdir(NodePath.join(directory, `${"0".repeat(64)}.reports`), { recursive: true })
    await Fs.writeFile(NodePath.join(directory, `${"0".repeat(64)}.blob`), "stale")

    // Nothing selected runs nothing and judges nothing.
    const calm = await runOf(workspace, ["notes/readme.txt"])
    expect(calm).toMatchObject({ ok: true, results: [], counts: { ran: 0, failed: 0 } })
    expect(calm).not.toHaveProperty("coverage")
    expect(await blobs(workspace)).toEqual(after)
  })

  it("fails the target's row when the merged coverage misses a threshold", async () => {
    const workspace = await fixture()
    await write(
      workspace.root,
      "pkg/test/c.test.ts",
      `import { c } from "../src/c.ts"\n// UNCOVERED\nexport const t = c\n`
    )
    const record = await runOf(workspace, "all")
    expect(record.ok).toBe(false)
    expect(record.counts).toEqual({ hit: 0, ran: 4, failed: 1, skipped: 0 })
    const merged = record.results.at(-1)!
    expect(merged).toMatchObject({ label: target, status: "failed", attempts: [{ passed: false }] })
    expect(merged.error).toContain("merged 4")
    expect(merged.error).toContain("ERROR: Coverage for lines does not meet threshold")
  })

  it("reports a failed unit with the end of its output and keeps no blob for it", async () => {
    const workspace = await fixture()
    await write(workspace.root, "pkg/test/a.test.ts", `import { a } from "../src/a.ts"\n// FAIL\nexport const t = a\n`)
    const record = await runOf(workspace, "all")
    expect(record.ok).toBe(false)
    expect(record.counts).toEqual({ hit: 0, ran: 3, failed: 1, skipped: 0 })
    expect(record.coverage).toBe("a unit failed")
    expect(record.results[0]).toMatchObject({
      label: "//pkg:test#test/a.test.ts",
      status: "failed",
      attempts: [{ passed: false }],
      error: "AssertionError: expected 1 to be 2 in test/a.test.ts"
    })
    expect(await blobs(workspace)).toHaveLength(3)
  })

  it("fails a unit whose run exits zero and writes no blob", async () => {
    const workspace = await fixture()
    await write(
      workspace.root,
      "pkg/test/c.test.ts",
      `import { c } from "../src/c.ts"\n// NOBLOB\nexport const t = c\n`
    )
    const record = await runOf(workspace, ["pkg/test/c.test.ts"])
    expect(record.results).toHaveLength(1)
    expect(record.results[0]).toMatchObject({ status: "failed", error: "\nthe run wrote no blob" })
  })

  it("bounds the output a failed unit carries", async () => {
    const workspace = await fixture()
    const index = await workspace.index()
    const units = await TestUnits.discover({ index, target })
    const record = await TestUnits.run({
      root: workspace.root,
      units,
      selected: [units.units[2]!],
      cacheDirectory: ".flows",
      jobs: 1,
      spawn: async (options) => {
        options.stderr("y".repeat(9000))
        return 1
      }
    })
    expect(record.results[0]!.error).toBe("y".repeat(4000))
  })

  it("fails a unit whose process cannot start, by a faulty spawner", async () => {
    const workspace = await fixture()
    const record = await runOf(workspace, ["pkg/src/c.ts"], async (options) => {
      options.stdout("starting")
      throw new ContainedProcess.ProcessError("process_failed", "the tool is not installed")
    })
    expect(record.results).toHaveLength(1)
    expect(record.results[0]).toMatchObject({ status: "failed", error: "starting\nthe tool is not installed" })
    const text = await runOf(workspace, ["pkg/src/c.ts"], () => Promise.reject("plain refusal"))
    expect(text.results[0]!.error).toBe("\nplain refusal")
  })
})

describe("command", () => {
  const base = { cacheDirectory: ".flows", base: "HEAD", all: false, list: false, closures: false } as const

  it("lists every unit with the reasons the working tree's change gives", async () => {
    const workspace = await fixture()
    await write(workspace.root, "pkg/src/c.ts", "export const c = 4\n")
    const index = await workspace.index()
    const listing = await TestUnits.command({ ...base, index, label: target, list: true }) as TestUnits.Listing
    expect(listing).toMatchObject({ target, files: ["pkg/src/c.ts"], shared: 4, selected: 1 })
    expect(listing.units.map((unit) => [unit.label, unit.selected, unit.reasons])).toEqual([
      ["//pkg:test#test/a.test.ts", false, []],
      ["//pkg:test#test/b.test.ts", false, []],
      ["//pkg:test#test/c.test.ts", true, [{ kind: "closure", file: "pkg/src/c.ts" }]],
      ["//pkg:test#test/lib.test.ts", false, []]
    ])
    expect(listing.units[2]).toMatchObject({ file: "pkg/test/c.test.ts", complete: true, reached: 2 })
    expect(listing.units[2]).not.toHaveProperty("closure")
  })

  it("lists every unit as selected with --all, with closures on request", async () => {
    const workspace = await fixture()
    const index = await workspace.index()
    const listing = await TestUnits.command({
      ...base,
      index,
      label: target,
      all: true,
      list: true,
      closures: true
    }) as TestUnits.Listing
    expect(listing.files).toEqual([])
    expect(listing.selected).toBe(4)
    expect(listing.units.every((unit) => unit.selected && unit.reasons[0]!.kind === "all")).toBe(true)
    expect(listing.units[0]!.closure!.entries).toEqual(["pkg/test/a.test.ts"])
  })

  it("runs the selected units and writes the record where asked", async () => {
    const workspace = await fixture()
    const index = await workspace.index()
    const record = await TestUnits.command({
      ...base,
      index,
      label: target,
      files: ["pkg/src/c.ts"],
      jobs: 1,
      resultsFile: "out/record.json"
    }) as TestUnits.RunRecord
    expect(record.results.map((row) => row.label)).toEqual(["//pkg:test#test/c.test.ts"])
    expect(record.jobs).toBe(1)
    expect(JSON.parse(await Fs.readFile(NodePath.join(workspace.root, "out/record.json"), "utf8"))).toEqual(record)
    const every = await TestUnits.command({ ...base, index, label: target, all: true }) as TestUnits.RunRecord
    expect(every.results.map((row) => row.label)).toEqual([
      "//pkg:test#test/a.test.ts",
      "//pkg:test#test/b.test.ts",
      "//pkg:test#test/c.test.ts",
      "//pkg:test#test/lib.test.ts",
      "//pkg:test"
    ])
    expect(every.jobs).toBe(Math.min(4, Os.availableParallelism()))
  })
})

describe("smithers-build units", () => {
  const serve = async (root: string, args: ReadonlyArray<string>) => {
    let exitCode = 0
    let envelope = ""
    let stderr = ""
    const terminal = (sink: (text: string) => void) => ({ write: sink, isTTY: false, columns: 100 })
    await makeCli({
      environment: { ...process.env, SMITHERS_AUDIENCE: "agent", NO_COLOR: "1", CI: undefined },
      stdout: terminal(() => {}),
      stderr: terminal((text) => {
        stderr += text
      })
    }).serve([...normalizeArgv(args), "--workspace", root, "--format", "json"], {
      exit: (code) => {
        exitCode = code
      },
      stdout: (text) => {
        envelope += text
      }
    })
    return { exitCode, envelope, stderr }
  }

  it("lists, runs, and fails with the labels that failed", async () => {
    const workspace = await fixture()
    const listed = await serve(workspace.root, ["units", target, "--list", "--files", "pkg/src/shared.ts"])
    expect(listed.exitCode).toBe(0)
    expect(JSON.parse(listed.envelope)).toMatchObject({ target, selected: 2, files: ["pkg/src/shared.ts"] })
    expect(listed.stderr).toBe("")

    const ran = await serve(workspace.root, ["units", target, "--files", "pkg/src/c.ts", "--jobs", "1"])
    expect(ran.exitCode).toBe(0)
    expect(JSON.parse(ran.envelope)).toMatchObject({ ok: true, counts: { ran: 1 }, verb: "units" })
    expect(ran.stderr).toMatch(/^ran \/\/pkg:test#test\/c\.test\.ts \d+ms\n$/m)

    await write(workspace.root, "pkg/test/a.test.ts", `import { a } from "../src/a.ts"\n// FAIL\nexport const t = a\n`)
    const failed = await serve(workspace.root, ["units", target])
    expect(failed.exitCode).toBe(1)
    expect(failed.envelope).toContain("units_failed")
    expect(failed.envelope).toContain("failed: //pkg:test#test/a.test.ts")

    const refused = await serve(workspace.root, ["units", "//pkg:lib"])
    expect(refused.exitCode).toBe(1)
    expect(refused.envelope).toContain("units_failed")
    expect(refused.envelope).toContain("runs as one unit")
  })
})
