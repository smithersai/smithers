/**
 * `affected` treats a declaration helper as it treats a `PACKAGE.ts`: a
 * module a declaration imports, by relative path or by workspace package
 * name, and everything that module imports in turn, builds targets in other
 * packages, so editing it selects the whole graph rather than the helper's
 * own package.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const labels = ["//app:files", "//lib:docs", "//lib:sources", "//lib:vendor", "//packages/helpers:lib", "//tools:own"]

const link = async (root: string, name: string, directory: string) => {
  await Fs.mkdir(Path.join(root, "node_modules", Path.dirname(name)), { recursive: true })
  await Fs.symlink(
    Path.relative(Path.join(root, "node_modules", Path.dirname(name)), Path.join(root, directory)),
    Path.join(root, "node_modules", name),
    "dir"
  )
}

const fixture = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-affected-helpers-")))
  roots.push(root)
  await write(root, "package.json", "{}")
  await write(root, "yarn.lock", "")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`
  )
  // A package whose helper module another declaration imports relatively.
  await write(root, "tools/helper.ts", "export const docs = \"docs/**/*.md\"\n")
  await write(root, "tools/own.txt", "")
  await write(
    root,
    "tools/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { own: S.Filegroup({ srcs: [S.file("own.txt")] }) } })
`
  )
  // A workspace package, with targets of its own, that declarations import by
  // name. Its import entry differs from its require entry, and it reaches a
  // relative module outside its entry's directory and a second workspace
  // package no declaration names.
  await write(
    root,
    "packages/helpers/package.json",
    JSON.stringify({
      name: "@fixture/helpers",
      type: "module",
      exports: { ".": { import: "./src/index.ts", require: "./dist/index.cjs" } }
    })
  )
  await write(root, "packages/helpers/dist/index.cjs", "exports.sources = \"src/**/*.ts\"\n")
  await write(
    root,
    "packages/helpers/src/index.ts",
    `export { sources } from "../shared/globs.ts"
export { pattern } from "@fixture/patterns"
`
  )
  await write(root, "packages/helpers/shared/globs.ts", "export const sources = \"src/**/*.ts\"\n")
  await write(root, "packages/helpers/README.md", "")
  await write(
    root,
    "packages/helpers/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { lib: S.Filegroup({ srcs: [S.glob("src/**/*.ts")] }) } })
`
  )
  await write(
    root,
    "packages/patterns/package.json",
    JSON.stringify({ name: "@fixture/patterns", type: "module", exports: { ".": "./index.ts" } })
  )
  await write(root, "packages/patterns/index.ts", "export const pattern = \"**/*.txt\"\n")
  await link(root, "@fixture/helpers", "packages/helpers")
  await link(root, "@fixture/patterns", "packages/patterns")
  // An installed third-party dependency is not a workspace module.
  await write(
    root,
    "node_modules/@fixture/vendor/package.json",
    JSON.stringify({ name: "@fixture/vendor", type: "module", exports: { ".": "./index.js" } })
  )
  await write(root, "node_modules/@fixture/vendor/index.js", "export const vendored = \"vendor/**\"\n")
  // A package whose declaration reaches a helper through its own imports map.
  await write(
    root,
    "app/package.json",
    JSON.stringify({ name: "app", type: "module", imports: { "#inputs": "./inputs.ts" } })
  )
  await write(root, "app/inputs.ts", "export const files = \"*.txt\"\n")
  await write(
    root,
    "app/PACKAGE.ts",
    `import { files } from "#inputs"
import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { files: S.Filegroup({ srcs: [S.glob(files)] }) } })
`
  )
  // The package whose cacheable targets the helpers build.
  await write(
    root,
    "lib/PACKAGE.ts",
    `import { sources } from "@fixture/helpers"
import { vendored } from "@fixture/vendor"
import { Smithers as S } from "@smthrs/targets"
import { docs } from "../tools/helper.ts"
export const Package = S.Package({ targets: {
  docs: S.Filegroup({ srcs: [S.glob(docs)] }),
  sources: S.Filegroup({ srcs: [S.glob(sources)] }),
  vendor: S.Filegroup({ srcs: [S.glob(vendored)] })
} })
`
  )
  const graph = await PackageLoader.load(await PackageDiscovery.discover(root))
  return { graph, index: PackageIndex.make(graph, root) }
}

it("records every declaration module, with the workspace modules reached by name and what they import", async () => {
  const { graph, index } = await fixture()
  const modules = [
    "WORKSPACE.ts",
    "app/PACKAGE.ts",
    "app/inputs.ts",
    "lib/PACKAGE.ts",
    "packages/helpers/PACKAGE.ts",
    "packages/helpers/shared/globs.ts",
    "packages/helpers/src/index.ts",
    "packages/patterns/index.ts",
    "tools/PACKAGE.ts",
    "tools/helper.ts"
  ]
  expect(graph.modules).toEqual(modules)
  expect(index.modules).toEqual(modules)
  const moduleRoots = ["app", "packages/helpers/src", "packages/patterns"]
  expect(graph.moduleRoots).toEqual(moduleRoots)
  expect(index.moduleRoots).toEqual(moduleRoots)
})

it.each([
  ["a relative helper", "tools/helper.ts"],
  ["a workspace package's import entry", "packages/helpers/src/index.ts"],
  ["a new file in a workspace package's source root", "packages/helpers/src/new.ts"],
  ["a nested file in a workspace package's source root", "packages/helpers/src/nested/helper.ts"],
  ["a module the import entry reaches outside its directory", "packages/helpers/shared/globs.ts"],
  ["a workspace package only another workspace package names", "packages/patterns/index.ts"],
  ["a helper behind the importing package's imports map", "app/inputs.ts"]
])("selects every target when %s changes, as a PACKAGE.ts change does", async (_name, file) => {
  const { index } = await fixture()
  const selected = Affected.select(index, ["//..."], [file], { explain: true })
  expect(selected).toMatchObject({ conservative: true, globalInputs: [file] })
  expect(selected.targets.map((target) => target.label).sort()).toEqual(labels)
  for (const target of selected.targets) {
    expect(target).toMatchObject({ reasons: [file], reasonDetails: [{ file, kind: "global-input" }] })
  }
})

it("keeps files no declaration evaluates owned by their package", async () => {
  const { index } = await fixture()
  const selected = Affected.select(index, ["//..."], ["tools/own.txt"])
  expect(selected).toMatchObject({ conservative: false, globalInputs: [] })
  expect(selected.targets).toEqual([{ label: "//tools:own", reasons: ["tools/own.txt"] }])
  // The require entry and the package's other files are not evaluated.
  for (
    const file of [
      "packages/helpers/dist/index.cjs",
      "packages/helpers/README.md",
      "packages/helpers/src-extra/helper.ts"
    ]
  ) {
    expect(Affected.select(index, ["//..."], [file])).toMatchObject({ conservative: false, globalInputs: [] })
  }
})

it("refreshes declaration inputs when a named helper reaches a new workspace package", async () => {
  const { graph } = await fixture()
  const root = graph.root
  await write(
    root,
    "packages/extra/package.json",
    JSON.stringify({ name: "@fixture/extra", type: "module", exports: { ".": "./src/index.ts" } })
  )
  await write(root, "packages/extra/src/index.ts", "export const extra = true\n")
  await link(root, "@fixture/extra", "packages/extra")
  await write(
    root,
    "packages/helpers/src/index.ts",
    `export { sources } from "../shared/globs.ts"
export { pattern } from "@fixture/patterns"
export { extra } from "@fixture/extra"
`
  )
  const discovery = await PackageDiscovery.discover(root)
  const refreshed = await PackageLoader.load(discovery)
  expect(refreshed).not.toBe(graph)
  expect(refreshed.modules).toContain("packages/extra/src/index.ts")
  expect(refreshed.moduleRoots).toContain("packages/extra/src")
  const selected = Affected.select(PackageIndex.make(refreshed, root), ["//..."], ["packages/extra/src/new.ts"])
  expect(selected).toMatchObject({ conservative: true, globalInputs: ["packages/extra/src/new.ts"] })
  expect(selected.targets.map((target) => target.label).sort()).toEqual(labels)
  expect(await PackageLoader.load(discovery)).toBe(refreshed)
})
