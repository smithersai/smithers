import * as Graph from "@smthrs/flow/Graph"
import * as Node from "@smthrs/plan/Node"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BiomeCheck } from "../src/BiomeCheck.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { plannedArgv, plannedCalls } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { force: true, recursive: true })))
})

const fixture = async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-biome-sources-"))
  roots.push(root)
  for (
    const file of [
      "packages/foo/src/main.ts",
      "packages/foo/src/other.js",
      "packages/foo/src/generated/skip.ts",
      "packages/foo/index.ts",
      "packages/foo/local.ts",
      "packages/foo/test/one.ts",
      "root.ts"
    ]
  ) {
    const path = Path.join(root, file)
    await Fs.mkdir(Path.dirname(path), { recursive: true })
    await Fs.writeFile(path, "export const value = 1\n")
  }
  return root
}

const expandedCommands = (target: Target.AnyTarget, expanded: Filegroup.Files) => {
  const plan = Target.plan(target)
  const graph = Graph.build(plan)
  expect(Graph.diagnostics(graph)).toEqual([])
  if (plan.ast._tag !== "Branch") throw new Error("expected a branch over expanded files")
  const mapper = Node.mapper(plan.ast.first)
  const predicate = Node.predicate(plan.ast)
  if (mapper === undefined || predicate === undefined) throw new Error("expected deferred expansion and selection")
  const value = mapper(expanded) as {
    readonly empty: boolean
    readonly lintArgv: ReadonlyArray<string>
    readonly formatArgv: ReadonlyArray<string>
  }
  const execs = Graph.nodes(graph).filter((node) =>
    node.ast._tag === "ActionCall" && node.ast.action === "smithers-build/exec"
  )
  return { value, selected: predicate(value), graph, execs }
}

describe("BiomeCheck paths and families", () => {
  it.each([
    { lint: true, format: false, commands: ["lint"] },
    { lint: false, format: true, commands: ["format"] },
    { lint: true, format: true, commands: ["lint", "format"] },
    { lint: false, format: false, commands: [] }
  ])("builds a real graph for the declared files and $commands", async ({ lint, format, commands }) => {
    const root = await fixture()
    const sources = [
      Input.glob("//packages/foo/src/**/*.ts", { exclude: ["//packages/foo/src/generated/**"] }),
      Input.file("//packages/foo/index.ts"),
      Input.glob("test/**/*.ts"),
      Input.file("local.ts"),
      Input.file("src/main.ts")
    ]
    const target = BiomeCheck({
      packageManager,
      sources,
      deps: [],
      config: Input.file("//biome.json"),
      lint,
      format,
      cwd: "packages/foo"
    })
    const resolved = [
      Input.glob("packages/foo/src/**/*.ts", { exclude: ["packages/foo/src/generated/**"] }),
      Input.file("packages/foo/index.ts"),
      Input.glob("packages/foo/test/**/*.ts"),
      Input.file("packages/foo/local.ts"),
      Input.file("packages/foo/src/main.ts")
    ]
    const expanded = await Filegroup.expand(root, resolved)
    expect(Target.metadata(target).inputs).toEqual([...sources, Input.file("//biome.json")])
    if (commands.length === 0) {
      expect(plannedCalls(target)).toEqual([])
      expect(Graph.diagnostics(Graph.build(Target.plan(target)))).toEqual([])
      return
    }
    const { value, selected, execs, graph } = expandedCommands(target, expanded)
    expect(selected).toBe(true)
    expect(execs).toHaveLength(commands.length)
    for (const command of commands) {
      expect(command === "lint" ? value.lintArgv : value.formatArgv).toEqual([
        "pnpm",
        "exec",
        "biome",
        command,
        "--config-path=../../biome.json",
        "index.ts",
        "local.ts",
        "src/main.ts",
        "test/one.ts"
      ])
    }
    expect(execs.map((node) => (node.payload as { cwd: string }).cwd)).toEqual(commands.map(() => "packages/foo"))
    const expansion = Graph.nodes(graph).find((node) =>
      node.ast._tag === "ActionCall" && node.ast.action === "smithers-build/filegroup"
    )
    expect(expansion?.payload).toEqual({ sources: resolved })
  })

  it.each([
    { cwd: "packages/foo", pattern: "//**/*.ts", expected: "../../root.ts" },
    { cwd: ".", pattern: "//**/*.ts", expected: "root.ts" },
    { cwd: "packages/foo", pattern: "src/**/*.ts", expected: "src/main.ts" }
  ])("expands $pattern from $cwd", async ({ cwd, pattern, expected }) => {
    const root = await fixture()
    const source = Input.glob(pattern, {
      exclude: [pattern.startsWith("//") ? "//**/generated/**" : "src/generated/**"]
    })
    const expanded = await Filegroup.expand(root, [Input.glob(Input.resolvePath(cwd, source.pattern), {
      exclude: source.exclude.map((path) => Input.resolvePath(cwd, path))
    })])
    const { value, selected } = expandedCommands(
      BiomeCheck({
        packageManager,
        sources: [source],
        deps: [],
        config: Input.file("biome.json"),
        lint: true,
        format: false,
        cwd
      }),
      expanded
    )
    expect(selected).toBe(true)
    expect(value.lintArgv).toContain(expected)
    expect(value.lintArgv.slice(5).every((path) => path.endsWith(".ts") && !path.includes("generated"))).toBe(true)
  })

  it("does not turn an empty glob expansion into a whole-directory check", async () => {
    const root = await fixture()
    const sources = [Input.glob("missing/**/*.ts")]
    const expanded = await Filegroup.expand(root, sources)
    expect(expanded).toEqual([])
    const { value, selected, graph } = expandedCommands(
      BiomeCheck({
        packageManager,
        sources,
        deps: [],
        config: Input.file("biome.json"),
        lint: true,
        format: true
      }),
      expanded
    )
    expect(value.empty).toBe(true)
    expect(selected).toBe(false)
    const skipped = Graph.nodes(graph).find((node) => node.id === "root.else")
    expect(skipped).toMatchObject({ kind: "Succeed", payload: { check: null, format: null } })
  })

  it("keeps direct files and the default directory check", () => {
    expect(plannedArgv(BiomeCheck({
      packageManager,
      sources: [Input.file("//root.ts"), Input.file("local.ts"), Input.file("local.ts")],
      deps: [],
      config: Input.file("//biome.json"),
      cwd: "packages/foo",
      lint: true,
      format: false
    }))).toEqual(["pnpm", "exec", "biome", "lint", "--config-path=../../biome.json", "../../root.ts", "local.ts"])
    expect(
      plannedCalls(BiomeCheck({
        packageManager,
        sources: [],
        deps: [],
        config: Input.file("biome.json"),
        lint: false,
        format: true
      }))[0]?.payload["argv"]
    ).toEqual(["pnpm", "exec", "biome", "format", "--config-path=biome.json", "."])
  })
})
