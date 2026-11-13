/**
 * Affected selection at its edges: a process runner that fails outside the
 * contained-process contract, a verb that depends on a target no package
 * owns, and one dependency selector shared by several targets.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import * as Schema from "effect/Schema"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const attrs = Schema.Struct({
  inputs: Schema.Array(Input.Declared),
  dependencies: Schema.Array(Target.Target),
  selectors: Schema.Array(Target.DependencySelector)
})

const target = (
  inputs: ReadonlyArray<Input.Declared>,
  dependencies: ReadonlyArray<Target.AnyTarget> = [],
  view?: Partial<Target.KindView>
): Target.AnyTarget =>
  S.Target.make("Fixture", {
    attrs,
    kinds: view === undefined ? [] : ["build"],
    cache: () => true,
    attrsForKind: (_kind, base) =>
      view === undefined ? base : ({
        inputs: view.inputs ?? [],
        dependencies: view.dependencies ?? [],
        selectors: view.dependencySelectors ?? []
      }),
    implementation: () => Target.notImplemented("selection fixture")
  })({ inputs, dependencies, selectors: [] })

const index = (packages: Record<string, Record<string, Target.AnyTarget>>) =>
  PackageIndex.make({
    root: Path.resolve("test/fixtures/affected-selection"),
    workspace: S.Workspace("affected-edges", {
      repository: "git+https://example.invalid/affected.git",
      cache: S.Cache({ directory: ".flows" })
    }),
    factory: undefined,
    modules: [],
    packages: Object.entries(packages).map(([packagePath, targets]) => ({
      file: packagePath === "" ? "PACKAGE.ts" : `${packagePath}/PACKAGE.ts`,
      packagePath,
      value: S.Package({ targets })
    }))
  })

describe("Affected.changedPaths with an injected runner", () => {
  it("classifies a runner failure that is not a contained-process error as process_failed", async () => {
    const failing = async () => {
      throw new Error("spawn refused by policy")
    }
    await expect(Affected.changedPaths("/work", { base: "main" }, failing)).rejects.toMatchObject({
      _tag: "smithers-build/AffectedGitError",
      code: "process_failed",
      args: ["rev-parse", "--verify", "--end-of-options", "main^{commit}"],
      message: "git rev-parse failed: spawn refused by policy"
    })
  })

  it("renders a non-Error rejection in the refusal message", async () => {
    const failing = () => Promise.reject("runner unavailable")
    await expect(Affected.changedPaths("/work", { base: "main" }, failing)).rejects.toMatchObject({
      code: "process_failed",
      message: "git rev-parse failed: runner unavailable",
      cause: "runner unavailable"
    })
  })
})

describe("Affected.select graph edges", () => {
  it("names a verb dependency no package owns as a root-private target in the explanation", () => {
    const orphan = target([Input.file("//shared/data.txt")])
    const app = target([Input.file("main.ts")], [], { dependencies: [orphan] })
    const graph = index({ app: { build: app }, shared: { data: target([Input.file("data.txt")]) } })
    expect(graph.ownerOf(orphan)).toBeUndefined()
    const explained = Affected.select(graph, ["//app:build"], ["shared/data.txt"], { explain: true })
    expect(explained.conservative).toBe(false)
    expect(explained.targets).toEqual([{
      label: "//app:build",
      reasons: ["shared/data.txt"],
      reasonDetails: [{
        file: "shared/data.txt",
        kind: "declared-input",
        label: "//:__private_Fixture_1",
        rule: "Fixture",
        input: Input.file("//shared/data.txt"),
        dependencyPath: ["//app:build", "//:__private_Fixture_1"]
      }]
    }])
  })

  it("resolves a dependency selector once when several targets share it", () => {
    const helper = target([Input.file("helper.ts")])
    const selector = Target.subtree("//lib/...", "helper")
    const graph = index({
      lib: { helper },
      first: { build: target([Input.file("a.ts")], [], { dependencySelectors: [selector] }) },
      second: { build: target([Input.file("b.ts")], [], { dependencySelectors: [selector] }) }
    })
    expect(Affected.select(graph, ["//first:build", "//second:build"], ["lib/helper.ts"]).targets).toEqual([
      { label: "//first:build", reasons: ["lib/helper.ts"] },
      { label: "//second:build", reasons: ["lib/helper.ts"] }
    ])
    expect(Affected.select(graph, ["//first:build", "//second:build"], ["first/a.ts"]).targets).toEqual([
      { label: "//first:build", reasons: ["first/a.ts"] }
    ])
  })
})
