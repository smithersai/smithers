/**
 * Affected selection does not lean on the result cache.
 *
 * A test, type-check or lint result is reused once a confined run proved its
 * reads, but selection is decided before any run: a file a declaration does
 * not name can still change what the tool does, so a change to it selects
 * the target. These cases hold that line for every tool-backed rule, cached
 * or not, with build confinement on, off and undeclared.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as CacheEvidence from "../src/internal/CacheEvidence.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const targets = () => {
  const source = S.file("source.ts")
  const config = S.file("config.json")
  return {
    test: S.Vitest({
      tests: [S.file("case.test.ts")],
      sources: [source],
      deps: [],
      config,
      environment: "node",
      passWithNoTests: false,
      cwd: "pkg"
    }),
    node: S.NodeTest({ runner: S.testRunner([S.file("case.test.ts")]), srcs: [source], deps: [], cwd: "pkg" }),
    check: S.Typecheck({
      srcs: [source],
      deps: [],
      tsconfig: config,
      buildMode: false,
      incremental: false,
      cwd: "pkg"
    }),
    lint: S.EsLint({ sources: [source], deps: [], configs: [config], maxWarnings: 0, fix: false, cwd: "pkg" }),
    build: S.TsBuild({
      srcs: [source],
      entries: [source],
      deps: [],
      tsconfig: config,
      tool: { name: "tsc" },
      format: "esm",
      outDir: "dist",
      cwd: "pkg"
    }),
    fmt: S.Dprint({ sources: [source], deps: [], config, fix: false, cwd: "pkg" })
  }
}

const index = (sandboxes: ReturnType<typeof S.Sandboxes> | undefined) =>
  PackageIndex.make({
    root: Path.resolve("test/fixtures/affected-selection"),
    workspace: S.Workspace("affected-evidence", {
      repository: "git+https://example.invalid/affected.git",
      cache: S.Cache({ directory: ".flows" }),
      ...(sandboxes === undefined ? {} : { sandboxes })
    }),
    factory: undefined,
    modules: [],
    packages: [
      { file: "pkg/PACKAGE.ts", packagePath: "pkg", value: S.Package({ targets: targets() }) },
      { file: "other/PACKAGE.ts", packagePath: "other", value: S.Package({ targets: {} }) }
    ]
  })

const every = ["//pkg:build", "//pkg:check", "//pkg:fmt", "//pkg:lint", "//pkg:node", "//pkg:test"]

describe.each([
  ["with build confinement off", S.Sandboxes({ default: S.Sandbox.None() })],
  ["with the platform's confinement", undefined],
  ["with bubblewrap declared", S.Sandboxes({ default: S.Sandbox.Bubblewrap() })]
])("Affected.select %s", (_name, sandboxes) => {
  const graph = index(sandboxes)
  const selected = (files: ReadonlyArray<string>) =>
    Affected.select(graph, ["//pkg/..."], files).targets.map((target) => target.label).sort()

  it("selects every tool-backed target for a file in its package that no declaration names", () => {
    expect(selected(["pkg/undeclared.txt"])).toEqual(every)
    const selection = Affected.select(graph, ["//pkg/..."], ["pkg/undeclared.txt"])
    expect(selection.conservative).toBe(false)
    for (const target of selection.targets) expect(target.reasons).toEqual(["pkg/undeclared.txt"])
  })

  it("selects each target for its declared inputs, and all of them for a file no target owns", () => {
    expect(selected(["pkg/source.ts"])).toEqual(every)
    expect(selected(["other/file.txt"])).toEqual(every)
    expect(Affected.select(graph, ["//pkg/..."], ["other/file.txt"]).conservative).toBe(true)
  })
})

describe("the rules that are reused with evidence", () => {
  it("are each still selected by an undeclared sibling, so a result that is never stored still reruns", () => {
    const graph = index(S.Sandboxes({ default: S.Sandbox.None() }))
    const rules = new Map(
      Affected.select(graph, ["//pkg/..."], ["pkg/undeclared.txt"], { explain: true }).sources.map((source) =>
        [source.label, source.rule] as const
      )
    )
    for (const rule of CacheEvidence.rules) expect([...rules.values()]).toContain(rule)
    // The two tool-backed rules that are never reused stay selected as well.
    expect([...rules.values()]).toEqual(expect.arrayContaining(["TsBuild", "Dprint"]))
  })
})
