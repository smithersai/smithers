import { describe, expect, it } from "vitest"
import { type Config, defines, readConfig, rootRuns, walk } from "../../src/decompose/Turbo.vibe"
import { assemble, type Package, type Workspace } from "../../src/decompose/Workspace.vibe"

const workspace = assemble("pnpm", {}, false, [
  ["packages/core", JSON.stringify({ name: "core", scripts: { build: "tsc", test: "vitest" } })],
  [
    "packages/ui",
    JSON.stringify({ name: "ui", scripts: { build: "tsc", codegen: "gen" }, dependencies: { core: "*" } })
  ],
  [
    "apps/web",
    JSON.stringify({ name: "web", scripts: { test: "vitest", build: "vite build" }, dependencies: { ui: "*" } })
  ],
  ["apps/docs", JSON.stringify({ name: "docs", scripts: { lint: "eslint ." } })]
]) as Workspace

const named = (name: string): Package => workspace.packages.find((candidate) => candidate.name === name) as Package

const config = (root: unknown, packages: Readonly<Record<string, unknown>> = {}): Config =>
  readConfig(JSON.stringify(root), Object.entries(packages).map(([name, own]) => [name, JSON.stringify(own)])) as Config

/** The scripts a walk runs, as `package#script`. */
const ran = (settings: Config, start: string, ...tasks: ReadonlyArray<string>): ReadonlyArray<string> =>
  walk(settings, workspace, named(start), tasks).scripts.map(([owner, script]) => `${owner.name}#${script}`).sort()

describe("readConfig", () => {
  it("reads tasks, or the older pipeline, with comments and trailing commas", () => {
    const read = readConfig(
      `{
      // the task graph
      "globalDependencies": ["tsconfig.base.json", 7, "./config/build.mjs", "!ignored.json", "../outside", "/abs", "a/../../b", "./"],
      "tasks": { "build": { "dependsOn": ["^build"], "inputs": ["src/**"], }, "lint": {}, "odd": "text" },
    }`,
      []
    )
    // Written from the root; a glob that negates or leaves the repository adds nothing.
    expect(read?.globalDependencies).toEqual(["tsconfig.base.json", "config/build.mjs"])
    expect(read?.tasks.get("build")).toEqual({
      dependsOn: ["^build"],
      inputs: ["src/**"],
      extendsDependsOn: false,
      extendsInputs: false
    })
    expect(read?.tasks.get("lint")).toEqual({ dependsOn: [], inputs: [], extendsDependsOn: true, extendsInputs: true })
    expect(read?.tasks.get("odd")?.dependsOn).toEqual([])
    expect(readConfig(`{ "pipeline": { "build": { "dependsOn": "not a list" } } }`, [])?.tasks.get("build")?.dependsOn)
      .toEqual([])
  })

  it("gives nothing when a file does not parse or has no tasks", () => {
    expect(readConfig(`{ "tasks": `, [])).toBeUndefined()
    expect(readConfig(`[]`, [])).toBeUndefined()
    expect(readConfig(`{}`, [])).toBeUndefined()
    expect(readConfig(`{ "tasks": [] }`, [])).toBeUndefined()
    expect(readConfig(`{ "tasks": {} }`, [["ui", `{ broken`]])).toBeUndefined()
  })

  it("reads a package's file that holds no tasks as changing none", () => {
    expect(readConfig(`{ "tasks": {} }`, [["ui", `{ "extends": ["//"], "tags": ["x"] }`]])?.packages.get("ui")?.size)
      .toBe(0)
  })
})

describe("defines and rootRuns", () => {
  const settings = config({ tasks: { build: {}, "web#deploy": {}, "//#format": {} } }, {
    ui: { tasks: { codegen: {} } }
  })

  it("knows a task the root, one package's key, or a package's own file defines", () => {
    expect(defines(settings, "build")).toBe(true)
    expect(defines(settings, "deploy")).toBe(true)
    expect(defines(settings, "codegen")).toBe(true)
    expect(defines(settings, "format")).toBe(true)
    expect(defines(settings, "test")).toBe(false)
    expect(defines(settings, "ploy")).toBe(false)
  })

  it("knows a task of the root package", () => {
    expect(rootRuns(settings, "format")).toBe(true)
    expect(rootRuns(settings, "build")).toBe(false)
  })
})

describe("walk", () => {
  it("runs only the package's own script when the task depends on nothing", () => {
    const settings = config({ tasks: { test: {} } })
    expect(ran(settings, "web", "test")).toEqual(["web#test"])
    // A package without the script runs nothing.
    expect(ran(settings, "ui", "test")).toEqual([])
    expect(walk(settings, workspace, named("ui"), ["test"]).packages).toEqual([])
  })

  it("follows ^task into declared packages, through a package without the script", () => {
    const settings = config({ tasks: { test: { dependsOn: ["^test"] } } })
    // ui has no test script, and its own ^test is still followed to core.
    expect(ran(settings, "web", "test")).toEqual(["core#test", "web#test"])
  })

  it("follows a task of the same package and a named package's task", () => {
    const settings = config({
      tasks: {
        test: { dependsOn: ["build", "docs#lint", "missing#build", "$ENV_VAR"] },
        build: { dependsOn: ["^build"] },
        lint: {}
      }
    })
    expect(ran(settings, "web", "test")).toEqual(["core#build", "docs#lint", "ui#build", "web#build", "web#test"])
    expect(walk(settings, workspace, named("web"), ["test"]).packages.map((owner) => owner.name).sort()).toEqual([
      "core",
      "docs",
      "ui",
      "web"
    ])
  })

  it("uses a package#task definition in place of the root's task", () => {
    const settings = config({
      tasks: { build: { dependsOn: ["^build"] }, "ui#build": { dependsOn: ["codegen"] }, codegen: {} }
    })
    expect(ran(settings, "ui", "build")).toEqual(["ui#build", "ui#codegen"])
    expect(ran(settings, "web", "build")).toEqual(["ui#build", "ui#codegen", "web#build"])
  })

  it("lets a package's own file replace a list, or extend it with $TURBO_EXTENDS$", () => {
    const root = { tasks: { build: { dependsOn: ["^build"], inputs: ["$TURBO_ROOT$/shared.ts"] }, codegen: {} } }
    const replaced = config(root, { ui: { extends: ["//"], tasks: { build: { dependsOn: ["codegen"] } } } })
    expect(ran(replaced, "ui", "build")).toEqual(["ui#build", "ui#codegen"])
    // The list this file does not write is the root's.
    expect(walk(replaced, workspace, named("ui"), ["build"]).globs).toEqual(["shared.ts"])
    const extended = config(root, {
      ui: {
        tasks: {
          build: { dependsOn: ["$TURBO_EXTENDS$", "codegen"], inputs: ["$TURBO_EXTENDS$", "$TURBO_ROOT$/own.ts"] }
        }
      }
    })
    expect(ran(extended, "ui", "build")).toEqual(["core#build", "ui#build", "ui#codegen"])
    expect(walk(extended, workspace, named("ui"), ["build"]).globs).toEqual(["own.ts", "shared.ts"])
    const narrowed = config(root, { core: { tasks: { build: { inputs: ["src/**"] } } } })
    expect(walk(narrowed, workspace, named("core"), ["build"]).globs).toEqual([])
    // A task with no script reads nothing: docs has no build.
    expect(walk(root === undefined ? narrowed : config(root), workspace, named("docs"), ["build"]).globs).toEqual([])
    const added = config({ tasks: {} }, { ui: { tasks: { codegen: {} } } })
    expect(ran(added, "ui", "codegen")).toEqual(["ui#codegen"])
    expect(ran(added, "web", "codegen")).toEqual([])
  })

  it("collects inputs that leave the package, and never the ones that narrow it", () => {
    const settings = config({
      tasks: {
        build: {
          inputs: [
            "$TURBO_DEFAULT$",
            "!**/*.test.ts",
            "src/**",
            "$TURBO_ROOT$/tools/build.ts",
            "../shared/**",
            "$TURBO_ROOT$/",
            "../../.."
          ]
        }
      }
    })
    expect(walk(settings, workspace, named("core"), ["build"]).globs).toEqual(["packages/shared/**", "tools/build.ts"])
  })

  it("notes when a task of the root package runs", () => {
    const settings = config({ tasks: { test: { dependsOn: ["//#codegen"] }, "//#codegen": {} } })
    expect(walk(settings, workspace, named("web"), ["test"])).toMatchObject({ root: true })
    expect(walk(config({ tasks: { test: {} } }), workspace, named("web"), ["test"]).root).toBe(false)
  })

  it("walks several tasks once each, and stops at a cycle", () => {
    const settings = config({ tasks: { build: { dependsOn: ["test"] }, test: { dependsOn: ["build"] } } })
    expect(ran(settings, "web", "build", "test")).toEqual(["web#build", "web#test"])
    expect(ran(settings, "docs", "undefined-task")).toEqual([])
  })

  it("keeps two tasks apart that are spelled the same with `#`", () => {
    const packages: ReadonlyArray<Package> = [
      { name: "a", directory: "packages/a", scripts: { "x#y": "one" }, dependencies: [] },
      { name: "a#x", directory: "packages/ax", scripts: { y: "two" }, dependencies: [] },
      { name: "b", directory: "packages/b", scripts: { build: "tsc" }, dependencies: ["a#x"] }
    ]
    const settings = config({ tasks: { build: { dependsOn: ["^y", "a#x#y"] }, y: {}, "x#y": {} } })
    const walked = walk(settings, { ...workspace, packages }, packages[2] as Package, ["build"])
    // `a#x#y` names the task `x#y` of `a`, and `^y` the task `y` of the package `a#x`: both run.
    expect(walked.scripts.map(([owner, script]) => [owner.name, script])).toEqual([
      ["b", "build"],
      ["a", "x#y"],
      ["a#x", "y"]
    ])
  })
})
