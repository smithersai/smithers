import { Smithers as S } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import * as Schema from "effect/Schema"
import * as Path from "node:path"
import { expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import { causes, reasons } from "./helpers/AffectedExplain.ts"

const attrs = Schema.Struct({
  inputs: Schema.Array(Input.Declared),
  dependencies: Schema.Array(Target.Target),
  selectors: Schema.Array(Target.DependencySelector),
  cacheable: Schema.Boolean
})

// Exercise the public rule constructor, including its real metadata and verb
// views. Unlike fabricated target handles, this follows declaration validation,
// attr collection and snapshots before affected selection sees the graph.
const target = (
  inputs: ReadonlyArray<Input.Declared> = [],
  dependencies: ReadonlyArray<Target.AnyTarget> = [],
  view?: Partial<Target.KindView>,
  cacheable = true
): Target.AnyTarget =>
  S.Target.make("Fixture", {
    attrs,
    kinds: view === undefined ? [] : ["build"],
    cache: (attrs) => attrs.cacheable,
    attrsForKind: (_kind, base) =>
      view === undefined ? base : ({
        inputs: view.inputs ?? [],
        dependencies: view.dependencies ?? [],
        selectors: view.dependencySelectors ?? [],
        cacheable: view.cacheable ?? true
      }),
    implementation: () => Target.notImplemented("selection fixture")
  })({ inputs, dependencies, selectors: [], cacheable })

const workspace = S.Workspace("affected", {
  repository: "git+https://example.invalid/affected.git",
  cache: S.Cache({ directory: ".flows" })
})

const fixture = (modules: ReadonlyArray<string> = []) => {
  const packages = new Map<string, Record<string, Target.AnyTarget>>()
  return {
    add: (packagePath: string, key: string, value: Target.AnyTarget) => {
      const targets = packages.get(packagePath) ?? {}
      targets[key] = value
      packages.set(packagePath, targets)
      return value
    },
    get index() {
      return PackageIndex.make({
        root: Path.resolve("test/fixtures/affected-selection"),
        workspace,
        factory: undefined,
        modules,
        packages: [...packages].map(([packagePath, targets]) => ({
          file: packagePath === "" ? "PACKAGE.ts" : `${packagePath}/PACKAGE.ts`,
          packagePath,
          value: S.Package({ targets })
        }))
      })
    }
  }
}

it("explains shared ambient selection through private dependencies without claiming input ownership", () => {
  const graph = fixture()
  const { add } = graph
  const workspace = add("", "workspace", target([Input.pnpmWorkspace("//pnpm-workspace.yaml")], [], undefined, false))
  const privateTarget = S.Filegroup({ srcs: [Input.file("local.txt"), workspace], cwd: "." })
  add("other", "test", target([Input.file("local.txt")], [privateTarget]))
  add("lib", "src", target([Input.glob("src/**/*.ts")]))
  const selected = Affected.select(graph.index, ["//other:test"], ["lib/src/a.ts"], { explain: true })
  expect(selected).toEqual({
    pattern: "//other:test",
    files: ["lib/src/a.ts"],
    conservative: false,
    globalInputs: [],
    globalCauses: [],
    targets: [{ label: "//other:test", sources: [0] }],
    sources: [{ label: "//:workspace", rule: "Fixture", changes: [0, 1] }],
    changeSets: [[0], [1]],
    changes: [
      { file: "lib/src/a.ts", kind: "ambient-input", input: Input.pnpmWorkspace("//pnpm-workspace.yaml") },
      { file: "lib/src/a.ts", kind: "uncacheable" }
    ],
    edges: {
      "//:workspace": ["//other:__private_Filegroup_1"],
      "//other:__private_Filegroup_1": ["//other:test"]
    }
  })
  expect(reasons(selected, "//other:test")).toEqual(["lib/src/a.ts"])
  expect(causes(selected, "//other:test")).toEqual([{
    file: "lib/src/a.ts",
    kind: "ambient-input",
    label: "//:workspace",
    rule: "Fixture",
    input: Input.pnpmWorkspace("//pnpm-workspace.yaml"),
    dependencyPath: ["//other:test", "//other:__private_Filegroup_1", "//:workspace"]
  }, {
    file: "lib/src/a.ts",
    kind: "uncacheable",
    label: "//:workspace",
    rule: "Fixture",
    dependencyPath: ["//other:test", "//other:__private_Filegroup_1", "//:workspace"]
  }])
  expect(Affected.select(graph.index, ["//other:test"], ["lib/src/a.ts"]).targets).toEqual([
    { label: "//other:test", reasons: ["lib/src/a.ts"] }
  ])
})

it("preserves owned, declared unowned, and multi-root reasons including excludes and dotfiles", () => {
  const graph = fixture()
  const { add } = graph
  const lib = add("lib", "src", target([Input.glob("src/**/*.ts")]))
  const shared = Input.glob("//shared/**/*.ts", { exclude: ["//shared/generated/**"] })
  add("app", "build", target([shared, Input.file("//assets/schema.txt")], [lib]))
  add("tools", "check", target([Input.file("local.txt")], [], { dependencies: [lib] }))
  const paths = ["shared/.hidden.ts", "./lib/new.txt", "assets/schema.txt", "lib\\new.txt"]
  expect(Affected.select(graph.index, ["//..."], paths)).toEqual({
    pattern: "//...",
    files: ["assets/schema.txt", "lib/new.txt", "shared/.hidden.ts"],
    conservative: false,
    globalInputs: [],
    targets: [
      { label: "//app:build", reasons: ["assets/schema.txt", "lib/new.txt", "shared/.hidden.ts"] },
      { label: "//lib:src", reasons: ["lib/new.txt"] },
      { label: "//tools:check", reasons: ["lib/new.txt"] }
    ]
  })
  for (const path of ["scripts/unknown.ts", "shared/generated/code.ts", "pnpm-lock.yaml"]) {
    expect(Affected.select(graph.index, ["//..."], ["lib/new.txt", path])).toEqual({
      pattern: "//...",
      files: ["lib/new.txt", path].sort(),
      conservative: true,
      globalInputs: [path],
      targets: ["//lib:src", "//app:build", "//tools:check"].sort().map((label) => ({ label, reasons: [path] }))
    })
  }
  expect(Affected.select(graph.index, ["//..."], []).targets).toEqual([])
})

it("does not select a glob consumer for an excluded path owned by another package", () => {
  const graph = fixture()
  const { add } = graph
  add("app", "build", target([Input.glob("//shared/**", { exclude: ["//shared/generated/**"] })]))
  add("shared", "src", target([Input.glob("**/*")]))
  expect(Affected.select(graph.index, ["//..."], ["shared/generated/a.ts"])).toMatchObject({
    conservative: false,
    targets: [{ label: "//shared:src", reasons: ["shared/generated/a.ts"] }]
  })
})

it("keeps verb-only inputs unowned and empty base declarations conservative", () => {
  const graph = fixture()
  const { add } = graph
  add("app", "build", target([Input.file("local.txt")], [], { inputs: [Input.glob("//shared/**")] }))
  add("empty", "build", target([], [], { inputs: [Input.file("local.txt")] }))
  expect(Affected.select(graph.index, ["//..."], ["shared/file.ts"]).conservative).toBe(true)
  expect(Affected.select(graph.index, ["//..."], ["app/source.ts"]).targets).toEqual([
    { label: "//app:build", reasons: ["app/source.ts"] },
    { label: "//empty:build", reasons: ["app/source.ts"] }
  ])
})

it.each([Input.gitDiff(), Input.pnpmWorkspace("//pnpm-workspace.yaml")])(
  "preserves ambient $_tag selection for owned files without selecting unrelated targets",
  (input) => {
    const graph = fixture()
    const { add } = graph
    add("", "workspace", target([input]))
    add("app", "build", target([Input.glob("src/**/*.ts", { exclude: ["src/generated/**"] })]))
    add(
      "tools",
      "check",
      target([
        Input.file("//assets/schema.txt"),
        Input.glob("//shared/**/*.ts", { exclude: ["//shared/generated/**"] })
      ])
    )
    add("other", "build", target([Input.file("local.txt")]))
    const paths = ["app/src/generated/code.ts", "assets/schema.txt", "shared/.hidden.ts"]
    expect(Affected.select(graph.index, ["//..."], paths)).toEqual({
      pattern: "//...",
      files: paths,
      conservative: false,
      globalInputs: [],
      targets: [
        { label: "//:workspace", reasons: paths },
        { label: "//app:build", reasons: [paths[0]] },
        { label: "//tools:check", reasons: paths.slice(1) }
      ]
    })
    expect(Affected.select(graph.index, ["//..."], []).targets).toEqual([])
  }
)

it.each([Input.gitDiff(), Input.pnpmWorkspace("//pnpm-workspace.yaml")])(
  "does not let ambient $_tag inputs claim unknown paths or excluded and adjacent inputs",
  (input) => {
    const graph = fixture()
    const { add } = graph
    add("", "workspace", target([input]))
    add("app", "build", target([Input.file("//assets/schema.txt")]))
    add(
      "tools",
      "check",
      target([
        Input.glob("//shared/**/*.ts", { exclude: ["//shared/generated/**"] })
      ])
    )
    for (
      const path of [
        ".github/ci-known-red.json",
        "application/src/file.ts",
        "assets/schema.txt.bak",
        "shared/generated/code.ts"
      ]
    ) {
      expect(Affected.select(graph.index, ["//..."], ["app/source.ts", path])).toEqual({
        pattern: "//...",
        files: ["app/source.ts", path].sort(),
        conservative: true,
        globalInputs: [path],
        targets: ["//:workspace", "//app:build", "//tools:check"].sort().map((label) => ({ label, reasons: [path] }))
      })
      expect(Affected.select(graph.index, ["//tools:check"], [path])).toMatchObject({
        conservative: true,
        targets: [{ label: "//tools:check", reasons: [path] }]
      })
    }
  }
)

it.each([Input.gitDiff(), Input.pnpmWorkspace("//pnpm-workspace.yaml")])(
  "selects verb-only ambient $_tag consumers for known paths without assigning ownership",
  (input) => {
    const graph = fixture()
    const { add } = graph
    add("app", "build", target([Input.file("local.txt")], [], { inputs: [input] }))
    add("lib", "src", target([Input.glob("src/**/*.ts")]))
    add("other", "build", target([Input.file("local.txt")]))
    expect(Affected.select(graph.index, ["//..."], ["lib/new.txt"])).toMatchObject({
      conservative: false,
      targets: [
        { label: "//app:build", reasons: ["lib/new.txt"] },
        { label: "//lib:src", reasons: ["lib/new.txt"] }
      ]
    })
    expect(Affected.select(graph.index, ["//..."], [".github/ci-known-red.json"])).toMatchObject({
      conservative: true,
      globalInputs: [".github/ci-known-red.json"],
      targets: ["//app:build", "//lib:src", "//other:build"].sort().map((label) => ({
        label,
        reasons: [".github/ci-known-red.json"]
      }))
    })
  }
)

it("selects uncacheable targets and their dependents for every change, since their inputs are incomplete", () => {
  const graph = fixture()
  const { add } = graph
  add("lib", "src", target([Input.glob("src/**/*.ts")]))
  const check = add("app", "check", target([Input.file("local.txt")], [], undefined, false))
  add("app", "bundle", target([Input.file("entry.ts")], [check]))
  add("tools", "test", target([Input.file("local.txt")], [], { cacheable: false }))
  add("other", "build", target([Input.file("local.txt")]))
  // A native rule that adds its own cache key keeps declared-input narrowing.
  add(
    "go",
    "test",
    S.Go.Test({ pkgs: ["./..."], data: [Input.file("local.txt")] })
  )
  const paths = ["lib/src/a.ts"]
  expect(Affected.select(graph.index, ["//..."], paths)).toEqual({
    pattern: "//...",
    files: paths,
    conservative: false,
    globalInputs: [],
    targets: ["//lib:src", "//app:check", "//app:bundle", "//tools:test"].sort().map((label) => ({
      label,
      reasons: paths
    }))
  })
  expect(Affected.select(graph.index, ["//other:build"], paths).targets).toEqual([])
  expect(Affected.select(graph.index, ["//..."], []).targets).toEqual([])
})

it("propagates through shared declared, verb and selector dependencies", () => {
  const graph = fixture()
  const { add } = graph
  const privateTarget = add("lib", "helper", target([Input.file("//lib/data.txt")]))
  add("first", "build", target([Input.file("local.txt")], [privateTarget]))
  add("second", "build", target([Input.file("local.txt")], [], { dependencies: [privateTarget] }))
  add(
    "selector",
    "build",
    target([Input.file("local.txt")], [], {
      dependencySelectors: [Target.subtree("//first/...", "build")]
    })
  )
  add("lib", "src", target([Input.file("data.txt")]))
  const paths = ["lib/data.txt", "lib/new.txt"]
  expect(Affected.select(graph.index, ["//..."], paths).targets).toEqual([
    { label: "//first:build", reasons: paths },
    { label: "//lib:helper", reasons: paths },
    { label: "//lib:src", reasons: paths },
    { label: "//second:build", reasons: paths },
    { label: "//selector:build", reasons: paths }
  ])
  expect(Affected.select(graph.index, ["//second:build"], paths).targets).toEqual([
    { label: "//second:build", reasons: paths }
  ])
  expect(graph.index.resolve("//first/...:build").map((row) => row.label)).toEqual(["//first:build"])
  const explained = Affected.select(graph.index, ["//selector:build"], ["lib/data.txt"], { explain: true })
  expect(causes(explained, explained.targets[0]!.label)).toEqual([
    {
      file: "lib/data.txt",
      kind: "declared-input",
      label: "//lib:helper",
      rule: "Fixture",
      input: Input.file("//lib/data.txt"),
      dependencyPath: ["//selector:build", "//first:build", "//lib:helper"]
    },
    {
      file: "lib/data.txt",
      kind: "package",
      label: "//lib:helper",
      rule: "Fixture",
      dependencyPath: ["//selector:build", "//first:build", "//lib:helper"]
    }
  ])
})

it("treats every declaration module, helpers included, as a global input", () => {
  const graph = fixture(["app/PACKAGE.ts", "tools/helper.ts", "packages/helpers/src/index.ts"])
  const { add } = graph
  add("app", "test", target([Input.file("local.txt")]))
  add("tools", "src", target([Input.glob("src/**/*.ts")]))
  add("packages/helpers", "lib", target([Input.glob("src/**/*.ts")]))
  for (const file of ["tools/helper.ts", "packages/helpers/src/index.ts"]) {
    expect(Affected.select(graph.index, ["//..."], [file], { explain: true })).toMatchObject({
      conservative: true,
      globalInputs: [file],
      globalCauses: [{ file, kind: "global-input" }],
      targets: ["//app:test", "//tools:src", "//packages/helpers:lib"].sort().map((label) => ({ label })),
      sources: [],
      changeSets: [],
      changes: [],
      edges: {}
    })
  }
  // A path that merely shares a module's prefix stays with its owner.
  expect(Affected.select(graph.index, ["//..."], ["tools/helper.ts.bak", "packages/helpers/src/index.ts.orig"]))
    .toMatchObject({ conservative: false, globalInputs: [] })
})

it("explains global and unknown fallbacks without inventing a dependency route", () => {
  const graph = fixture()
  const { add } = graph
  add("app", "test", target([Input.file("local.txt")]))
  for (const [file, kind] of [["pnpm-lock.yaml", "global-input"], ["unowned/a.txt", "unknown-input"]]) {
    expect(Affected.select(graph.index, ["//..."], [file!], { explain: true })).toEqual({
      pattern: "//...",
      files: [file],
      conservative: true,
      globalInputs: [file],
      globalCauses: [{ file, kind }],
      targets: [{ label: "//app:test" }],
      sources: [],
      changeSets: [],
      changes: [],
      edges: {}
    })
  }
  expect(Affected.select(graph.index, ["//..."], [], { explain: true }).targets).toEqual([])
})

it.each(
  [
    [Input.gitDiff(), false],
    [Input.gitDiff(), true],
    [Input.pnpmWorkspace("//pnpm-workspace.yaml"), false],
    [Input.pnpmWorkspace("//pnpm-workspace.yaml"), true]
  ] as const
)("explains ambient $_tag declarations in base and verb views (%s)", (input, verbOnly) => {
  const graph = fixture()
  const { add } = graph
  add("lib", "src", target([Input.glob("src/**")]))
  add(
    "app",
    "test",
    target(
      verbOnly ? [Input.file("local.txt")] : [input],
      [],
      verbOnly ? { inputs: [input] } : undefined
    )
  )
  expect(causes(Affected.select(graph.index, ["//app:test"], ["lib/src/a.ts"], { explain: true }), "//app:test"))
    .toEqual(
      [
        {
          file: "lib/src/a.ts",
          kind: "ambient-input",
          label: "//app:test",
          rule: "Fixture",
          input,
          dependencyPath: ["//app:test"]
        }
      ]
    )
})

it("distinguishes declared inputs, package membership, empty contracts and verb-only uncacheability", () => {
  const graph = fixture()
  const { add } = graph
  add("app", "test", target([Input.file("//assets/schema.txt")]))
  add("empty", "test", target())
  add("verb", "test", target([Input.file("local.txt")], [], { cacheable: false }))
  add(
    "go",
    "test",
    S.Go.Test({ pkgs: ["./..."], data: [Input.file("local.txt")] })
  )
  const paths = ["app/src/a.ts", "assets/schema.txt"]
  const selected = Affected.select(graph.index, ["//..."], paths, { explain: true })
  expect(selected.targets.map((row) => row.label)).toEqual(["//app:test", "//empty:test", "//verb:test"])
  expect(causes(selected, selected.targets[0]!.label)).toEqual([
    { file: paths[0], kind: "package", label: "//app:test", rule: "Fixture", dependencyPath: ["//app:test"] },
    {
      file: paths[1],
      kind: "declared-input",
      label: "//app:test",
      rule: "Fixture",
      input: Input.file("//assets/schema.txt"),
      dependencyPath: ["//app:test"]
    }
  ])
  expect(causes(selected, selected.targets[1]!.label)).toEqual(paths.map((file) => ({
    file,
    kind: "empty",
    label: "//empty:test",
    rule: "Fixture",
    dependencyPath: ["//empty:test"]
  })))
  expect(causes(selected, selected.targets[2]!.label)).toEqual(paths.map((file) => ({
    file,
    kind: "uncacheable",
    label: "//verb:test",
    rule: "Fixture",
    dependencyPath: ["//verb:test"]
  })))
})

it("uses one shortest route when an ambient source has shared dependency paths", () => {
  const graph = fixture()
  const { add } = graph
  const source = add("ambient", "diff", target([Input.gitDiff()]))
  const intermediate = add("middle", "build", target([Input.file("local.txt")], [source]))
  add("app", "test", target([Input.file("local.txt")], [intermediate, source]))
  add("lib", "src", target([Input.glob("src/**")]))
  const paths = ["lib/src/a.ts", "lib/src/b.ts"]
  expect(causes(Affected.select(graph.index, ["//app:test"], paths, { explain: true }), "//app:test")).toEqual(
    paths.map((file) => ({
      file,
      kind: "ambient-input",
      label: "//ambient:diff",
      rule: "Fixture",
      input: Input.gitDiff(),
      dependencyPath: ["//app:test", "//ambient:diff"]
    }))
  )
})

it("shares includes and excludes across real declaration views and successive selections", () => {
  const graph = fixture()
  const { add } = graph
  const input = Input.glob("//shared/**/*.ts", { exclude: ["//shared/generated/**"] })
  add("app", "build", target([input], [], { inputs: [input] }))
  add("tools", "build", target([input]))
  expect(Affected.select(graph.index, ["//..."], ["shared/a.ts", "shared/.b.ts"]).targets).toHaveLength(2)
  expect(Affected.select(graph.index, ["//..."], ["shared/c.ts"]).targets).toHaveLength(2)
  expect(Affected.select(graph.index, ["//..."], ["shared/generated/c.ts"]).conservative).toBe(true)
})

it("indexes 1000 targets once and selects 200 owned paths within a one-second CPU budget", () => {
  const graph = fixture()
  const { add } = graph
  for (let p = 0; p < 250; p++) {
    const owner = `packages/pkg${p}`
    const src = add(
      owner,
      "srcs",
      target([
        Input.glob("src/**/*.ts", { exclude: ["src/generated/**"] }),
        Input.glob("test/**/*.ts"),
        Input.file("package.json")
      ])
    )
    add(owner, "lint", target([Input.file("//eslint.config.js")], [src], { dependencies: [src] }))
    add(owner, "test", target([], [src]))
    add(owner, "build", target([], [src]))
  }
  const paths = Array.from({ length: 200 }, (_, i) => `packages/pkg${i}/src/file${i}.ts`)
  const index = graph.index
  // CPU time excludes scheduling delays on shared review/CI machines.
  const start = process.cpuUsage()
  const selection = Affected.select(index, ["//..."], paths)
  const elapsed = process.cpuUsage(start)
  expect(selection.conservative).toBe(false)
  expect(selection.targets).toHaveLength(800)
  expect(selection.targets.every((row) => row.reasons.length === 1)).toBe(true)
  expect((elapsed.user + elapsed.system) / 1000).toBeLessThan(1000)
})

it("calls changed files silent when any pattern names no target", () => {
  expect(Affected.silent(["a.ts"], [0])).toBe(true)
  expect(Affected.silent(["a.ts"], [3, 0])).toBe(true)
  expect(Affected.silent([], [0])).toBe(false)
  expect(Affected.silent(["a.ts"], [1, 2])).toBe(false)
})

it("never selects nothing for a real diff over a graph with targets, owned or not", () => {
  const graph = fixture()
  const { add } = graph
  graph.add("pkg", "lint", target([Input.glob("src/**/*.ts")]))
  const owned = Affected.select(graph.index, ["//..."], ["pkg/src/a.ts"])
  expect(owned).toMatchObject({ conservative: false, targets: [{ label: "//pkg:lint" }] })
  expect(Affected.select(graph.index, ["//..."], ["elsewhere/b.ts"])).toMatchObject({
    conservative: true,
    targets: [{ label: "//pkg:lint" }]
  })
})

it("names every label the summary holds no record of", () => {
  const summary = { results: [{ label: "//a:test" }, { label: "//b:test" }] }
  expect(Affected.unrecorded(["//a:test", "//b:test"], summary)).toEqual([])
  expect(Affected.unrecorded(["//a:test", "//c:test", "//d:test"], summary)).toEqual(["//c:test", "//d:test"])
  expect(Affected.unrecorded([], { results: [] })).toEqual([])
})

it("turns a selected gate skipped without a failure at the end of its chain red, keeping its reason and results", () => {
  const rows = [
    { label: "//a:review", status: "skipped", error: "the codex CLI is not installed" },
    { label: "//b:test", status: "skipped", blockedBy: "//a:review" },
    { label: "//d:test", status: "ran" },
    { label: "//e:dep", status: "skipped" }
  ]
  const green = { ok: true, counts: { hit: 0, ran: 1, failed: 0, skipped: 3 }, results: rows }
  const red = Affected.unskipped(["//a:review", "//b:test", "//d:test"], green)
  expect(red.ok).toBe(false)
  expect(red.counts).toEqual({ hit: 0, ran: 1, failed: 2, skipped: 1 })
  expect(red.results.map((row) => [row.label, row.status])).toEqual([
    ["//a:review", "failed"],
    ["//b:test", "failed"],
    ["//d:test", "ran"],
    ["//e:dep", "skipped"]
  ])
  expect(red.results[0]!.error).toBe("skipped without running: the codex CLI is not installed")
  // Something else failed (a known red, say). A skip whose chain ends at that failure is its shadow;
  // an unblocked skip, or one behind an unselected dependency's own skip, is still red.
  const failing = {
    ok: false,
    counts: { hit: 0, ran: 0, failed: 1, skipped: 4 },
    results: [
      { label: "//k:test", status: "failed", error: "known" },
      { label: "//a:review", status: "skipped", error: "the codex CLI is not installed" },
      { label: "//c:test", status: "skipped", blockedBy: "//k:test" },
      { label: "//d:review", status: "skipped", error: "the codex CLI is not installed" },
      { label: "//x:alias", status: "skipped", blockedBy: "//d:review" }
    ]
  }
  const still = Affected.unskipped(["//k:test", "//a:review", "//c:test", "//x:alias"], failing)
  expect(still.results.map((row) => [row.label, row.status])).toEqual([
    ["//k:test", "failed"],
    ["//a:review", "failed"],
    ["//c:test", "skipped"],
    ["//d:review", "skipped"],
    ["//x:alias", "failed"]
  ])
  expect(still.counts).toEqual({ hit: 0, ran: 0, failed: 3, skipped: 2 })
  // A chain that loops never counts as a failure's shadow.
  const loop = {
    ok: true,
    counts: { hit: 0, ran: 0, failed: 0, skipped: 2 },
    results: [
      { label: "//p:test", status: "skipped", blockedBy: "//q:test" },
      { label: "//q:test", status: "skipped", blockedBy: "//p:test" }
    ]
  }
  expect(Affected.unskipped(["//p:test"], loop).results[0]!.status).toBe("failed")
  // A summary with no such skip is returned as it was.
  expect(Affected.unskipped(["//d:test"], green)).toBe(green)
})

it("selects native declarations through their actual metadata and package index", () => {
  const graph = fixture()
  const sources = graph.add("lib", "sources", S.Filegroup({ srcs: [S.glob("src/**/*.ts")] }))
  graph.add("app", "check", S.Shell.Test({ shell: "true", data: [sources], sandbox: "none" }))
  expect(Target.metadata(sources).inputs).toEqual([S.glob("src/**/*.ts")])
  const selection = Affected.select(graph.index, ["//..."], ["lib/src/value.ts"], { explain: true })
  expect(selection.conservative).toBe(false)
  expect(selection.targets.map((row) => row.label)).toEqual(["//app:check", "//lib:sources"])
  expect(causes(selection, selection.targets[0]!.label)).toContainEqual({
    file: "lib/src/value.ts",
    kind: "declared-input",
    label: "//lib:sources",
    rule: "Filegroup",
    input: S.glob("src/**/*.ts"),
    dependencyPath: ["//app:check", "//lib:sources"]
  })
})

/** A small deterministic PRNG (mulberry32), so every generated case reproduces from its seed. */
const random = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Checks one seeded graph and says which case it exercised. */
const equivalent = (seed: number): "empty" | "conservative" | "single" | "shared" => {
  const next = random(seed)
  const pick = <A>(values: ReadonlyArray<A>): A => values[Math.floor(next() * values.length)]!
  const graph = fixture()
  const packages = ["p0", "p1", "p2", "shared"]
  const count = 2 + Math.floor(next() * 9)
  // A private target belongs to one package and only targets there may use it.
  const all: Array<{ readonly value: Target.AnyTarget; readonly home: string; readonly listed: boolean }> = []
  for (let n = 0; n < count; n++) {
    const home = pick(packages)
    const listed = n === 0 || next() >= 0.25
    const usable = all.filter((other) => other.listed || other.home === home).map((other) => other.value)
    const inputs: Array<Input.Declared> = []
    const roll = next()
    if (roll < 0.4) inputs.push(Input.file(`f${Math.floor(next() * 3)}.txt`))
    else if (roll < 0.6) inputs.push(Input.glob("//shared/**"))
    else if (roll < 0.65) inputs.push(Input.gitDiff())
    if (next() < 0.2) inputs.push(Input.file(`//shared/f${Math.floor(next() * 3)}.txt`))
    // Targets are immutable, so dependencies point at earlier targets; shared
    // and diamond-shaped paths still arise.
    const deps = usable.length === 0 ? [] : Array.from({ length: Math.floor(next() * 3) }, () => pick(usable))
    const viewDeps = usable.length > 0 && next() < 0.3 ? [pick(usable)] : []
    const value = target(
      inputs,
      [...new Set(deps)],
      viewDeps.length > 0 ? { dependencies: viewDeps } : undefined,
      next() > 0.1
    )
    // Some targets are private: reachable only as a dependency.
    if (listed) graph.add(home, `t${n}`, value)
    all.push({ value, home, listed })
  }
  const pool = [
    "p0/f0.txt",
    "p0/f1.txt",
    "p1/f2.txt",
    "p2/new.ts",
    "shared/f0.txt",
    "shared/f1.txt",
    "shared/deep/x.ts",
    ...(next() < 0.15 ? ["elsewhere/unowned.ts"] : []),
    ...(next() < 0.05 ? ["pnpm-lock.yaml"] : [])
  ]
  const paths = pool.filter(() => next() < 0.4)
  const index = graph.index
  const plain = Affected.select(index, ["//..."], paths)
  const explained = Affected.select(index, ["//..."], paths, { explain: true })
  expect(explained.targets.map((row) => row.label)).toEqual(plain.targets.map((row) => row.label))
  expect(explained.conservative).toBe(plain.conservative)
  expect(explained.globalInputs).toEqual(plain.globalInputs)
  if (explained.conservative) {
    expect(explained.sources).toEqual([])
    expect(explained.changeSets).toEqual([])
    expect(explained.changes).toEqual([])
    expect(explained.edges).toEqual({})
    expect(explained.globalCauses.map((cause) => cause.file)).toEqual(explained.globalInputs)
    for (const row of plain.targets) expect(row.reasons).toEqual(explained.globalInputs)
    return "conservative"
  }
  expect(explained.globalCauses).toEqual([])
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set([from])
    for (const label of seen) {
      if (label === to) return true
      for (const dependent of explained.edges[label] ?? []) seen.add(dependent)
    }
    return false
  }
  for (const [label, dependents] of Object.entries(explained.edges)) {
    expect(dependents).toEqual([...new Set(dependents)].sort())
    expect(dependents.length, label).toBeGreaterThan(0)
  }
  expect(new Set(explained.sources.map((source) => source.label)).size).toBe(explained.sources.length)
  // Each change record and each change set is stored once, in canonical order.
  const keys = explained.changes.map((change) => JSON.stringify(change))
  expect(new Set(keys).size).toBe(keys.length)
  expect(explained.changes.map((change) => change.file)).toEqual(explained.changes.map((change) => change.file).sort())
  const sets = explained.changeSets.map((set) => set.join())
  expect(new Set(sets).size).toBe(sets.length)
  for (const set of explained.changeSets) expect(set).toEqual([...new Set(set)].sort((left, right) => left - right))
  const used = explained.sources.flatMap((source) => source.changes)
  expect(new Set(used)).toEqual(new Set(explained.changeSets.keys()))
  expect(new Set(explained.changeSets.flat())).toEqual(new Set(explained.changes.keys()))
  const changeFiles = (source: number) =>
    explained.sources[source]!.changes.flatMap((set) =>
      explained.changeSets[set]!.map((change) => explained.changes[change]!.file)
    )
  plain.targets.forEach((row, position) => {
    const explainedRow = explained.targets[position]!
    const sources = explainedRow.sources!
    expect(sources).toEqual([...sources].sort((left, right) => left - right))
    const files = new Set(sources.flatMap(changeFiles))
    expect([...files].sort()).toEqual(row.reasons)
    // Exactly the sources that reach the root through `edges` are listed.
    const reaching = explained.sources.flatMap((source, at) => reaches(source.label, row.label) ? [at] : [])
    expect(sources).toEqual(reaching)
  })
  if (plain.targets.length === 0) return "empty"
  return explained.targets.some((row) => row.sources!.length > 1) ? "shared" : "single"
}

it("explain mode selects what plain mode selects, and its sources and edges rebuild each reason, over 1,000 seeded graphs", () => {
  const tally = { empty: 0, conservative: 0, single: 0, shared: 0 }
  for (let seed = 0; seed < 1000; seed++) {
    try {
      tally[equivalent(seed)]++
    } catch (cause) {
      throw new Error(`seed ${seed}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
  }
  // The generator reaches every case, so the property is not vacuous.
  expect(Object.values(tally).every((count) => count > 20), JSON.stringify(tally)).toBe(true)
})
