/** Private declarations keep one execution identity across independent plans. */
import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { declarationLabels } from "../src/internal/DeclarationLabels.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-private-labels-")))
  roots.push(root)
  await Fs.copyFile(
    new URL("./fixtures/private-labels/PACKAGE.ts.fixture", import.meta.url),
    Path.join(root, "PACKAGE.ts")
  )
  await write(root, "input.txt", "input\n")
  await write(
    root,
    "package.json",
    "{\"name\":\"private-labels\",\"private\":true,\"packageManager\":\"pnpm@11.25.0\"}\n"
  )
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("private-labels", {
  repository: "git+https://example.invalid/private-labels.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["node"] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
`
  )
  return root
}
const indexOf = async (root: string) =>
  PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
const plan = (index: PackageIndex, verb: "build" | "test", patterns = ["//..."]) =>
  PackageExec.plan({ index, patterns, cacheDirectory: ".flows", verb })
const filegroups = (planned: PackageExec.PackagePlan) => planned.workList.filter((node) => node.rule === "Filegroup")
const view = (node: PackageExec.PackageNode) => ({
  label: node.label,
  key: node.keyPreview,
  dependencies: node.dependencies,
  inputs: node.keyMaterial.inputs
})

describe("private declaration labels", () => {
  it("keeps the shared filegroup's label and execution view in build and test plans", async () => {
    const root = await fixture()
    const index = await indexOf(root)
    const build = await plan(index, "build")
    const test = await plan(index, "test")
    expect(filegroups(build)).toHaveLength(2)
    expect(filegroups(test)).toHaveLength(1)
    const shared = filegroups(test)[0]!
    const buildShared = filegroups(build).find((node) => node.declaration === shared.declaration)!
    expect(view(shared)).toEqual(view(buildShared))
    expect(new Set(filegroups(build).map((node) => node.label)).size).toBe(2)
    expect(index.targets().map((row) => row.label)).toEqual(["//:check", "//:first", "//:prepared", "//:suite"])
  })

  it.each([false, true])("agrees when roots are visited in opposite orders (reload=%s)", async (reload) => {
    const root = await fixture()
    const index = await indexOf(root)
    const forward = await plan(index, "build", ["//:first", "//:prepared"])
    const backward = await plan(reload ? await indexOf(root) : index, "build", ["//:prepared", "//:first"])
    expect(forward.roots).toEqual(["//:first", "//:prepared"])
    expect(backward.roots).toEqual(["//:prepared", "//:first"])
    for (const [label, node] of forward.nodes) expect(view(backward.nodes.get(label)!)).toEqual(view(node))
    const alone = await plan(index, "build", ["//:prepared"])
    expect(view(alone.nodes.get("//:prepared")!)).toEqual(view(forward.nodes.get("//:prepared")!))
  })

  it("runs ci after merging the fixture's build and test plans", async () => {
    const root = await fixture()
    const result = await serve(root, ["ci", "//...", "--no-cache", "--jobs", "2"])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(await Fs.readFile(Path.join(root, "first/ready"), "utf8")).toBe("ready\n")
    expect(await Fs.readFile(Path.join(root, "prepared/ready"), "utf8")).toBe("ready\n")
    expect(result.logs).toContain("//:check")
  })
})

describe("declaration positions", () => {
  it("distinguishes identical private handles, preserves sharing, and covers kind-only declarations", async () => {
    const root = await fixture()
    const loaded = await indexOf(root)
    const left = S.Filegroup({ srcs: [] })
    const right = S.Filegroup({ srcs: [] })
    const kindOnly = S.Filegroup({ srcs: [] })
    let viewCalls = 0
    const kindRoot = Target.make("Variant", {
      attrs: Schema.Struct({ dep: Schema.optional(Target.Target) }),
      kinds: ["test", "build"],
      attrsForKind: (_kind, attrs) => {
        viewCalls++
        return { ...attrs, dep: kindOnly }
      },
      implementation: () => Target.notImplemented("Variant")
    })({})
    const invalid = Target.make("InvalidVariant", {
      attrs: Schema.Struct({ value: Schema.String }),
      kinds: ["test"],
      attrsForKind: () => ({ value: 42 } as never),
      implementation: () => Target.notImplemented("InvalidVariant")
    })({ value: "valid base" })
    const named = S.Filegroup({ srcs: [left, right, left] })
    const index = PackageIndex.make({
      root,
      workspace: loaded.workspace,
      factory: undefined,
      packages: [{
        file: "nested/PACKAGE.ts",
        packagePath: "nested",
        value: S.Package({ targets: { named, kindRoot, invalid, alias: S.Alias(named) } })
      }]
    })
    const labels = declarationLabels(index, (target) => index.ownerOf(target) ?? "")
    expect(viewCalls).toBe(0)
    expect(labels.get(named)).toBe("//nested:named")
    expect(labels.get(left)).toMatch(/^\/\/nested:__private_Filegroup_[a-f0-9]{64}$/)
    expect(labels.get(right)).not.toBe(labels.get(left))
    expect(viewCalls).toBe(0)
    expect(labels.get(kindOnly)).toMatch(/^\/\/:__private_Filegroup_[a-f0-9]{64}$/)
    expect(viewCalls).toBe(Target.Kind.literals.length)
    expect(labels.get(S.Filegroup({ srcs: [] }))).toBeUndefined()
    expect(index.labelOf(left)).toBeUndefined()
    const again = declarationLabels(index, (target) => index.ownerOf(target) ?? "")
    for (const target of [named, left, right, kindOnly]) expect(again.get(target)).toBe(labels.get(target))
    const build = await plan(index, "build", ["//nested:kindRoot"])
    const test = await plan(index, "test", ["//nested:kindRoot"])
    expect(build.workList.find((node) => node.declaration === kindOnly)?.label).toBe(labels.get(kindOnly))
    expect(test.workList.find((node) => node.declaration === kindOnly)?.label).toBe(labels.get(kindOnly))
    await expect(plan(index, "test", ["//nested:invalid"])).rejects.toThrow(/declaration.*invalid/)
  })
})

describe("selection-independent named identity", () => {
  it.each([1, 2, 4, 8])("keeps named keys while adding %s unrelated private declarations", async (count) => {
    const root = await fixture()
    const loaded = await indexOf(root)
    const plain = S.Shell.Build({ shell: "true", outDirs: ["plain"], sandbox: "none" })
    const targets: Record<string, Target.AnyTarget> = { plain }
    const makeIndex = () =>
      PackageIndex.make({
        root,
        workspace: loaded.workspace,
        factory: undefined,
        packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { ...targets } }) }]
      })
    const before = await plan(makeIndex(), "build", ["//:plain"])
    for (let at = 0; at < count; at++) {
      targets[`extra${at}`] = S.Shell.Build({
        shell: "true",
        outDirs: [`extra-${at}`],
        data: [S.Filegroup({ srcs: [] })],
        sandbox: "none"
      })
    }
    const index = makeIndex()
    const patterns = index.targets().map((row) => row.label)
    const forward = await plan(index, "build", patterns)
    const backward = await plan(index, "build", [...patterns].reverse())
    expect(view(forward.nodes.get("//:plain")!)).toEqual(view(before.nodes.get("//:plain")!))
    const privateNodes = filegroups(forward).filter((node) => index.labelOf(node.declaration) === undefined)
    expect(new Set(privateNodes.map((node) => node.label)).size).toBe(count)
    for (const [label, node] of forward.nodes) expect(view(backward.nodes.get(label)!)).toEqual(view(node))
  })
})

describe("dependency verb views", () => {
  it("labels a private test-view helper beneath a build-only declaration", async () => {
    const root = await fixture()
    const loaded = await indexOf(root)
    const helper = S.Filegroup({ srcs: [] })
    const dependency = Target.make("BuildOnlyVariant", {
      attrs: Schema.Struct({ dep: Schema.optional(Target.Target) }),
      kinds: ["build"],
      attrsForKind: (kind, attrs) => kind === "test" ? { ...attrs, dep: helper } : attrs,
      implementation: () => Target.notImplemented("BuildOnlyVariant")
    })({})
    const check = S.Shell.Test({ shell: "true", data: [dependency], sandbox: "none" })
    const index = PackageIndex.make({
      root,
      workspace: loaded.workspace,
      factory: undefined,
      packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { dependency, check } }) }]
    })
    const forward = await plan(index, "test", ["//:check"])
    const backward = await plan(index, "test", ["//:check", "//..."])
    const helperNode = forward.workList.find((node) => node.declaration === helper)!
    expect(helperNode.label).toMatch(/^\/\/:__private_Filegroup_[a-f0-9]{64}$/)
    expect(view(backward.nodes.get(helperNode.label)!)).toEqual(view(helperNode))
  })
})
