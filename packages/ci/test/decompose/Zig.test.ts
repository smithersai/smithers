import { describe, expect, it } from "vitest"
import type { Closure } from "../../src/contract/Closure.ts"
import { type Step, toolCache } from "../../src/contract/Inventory.ts"
import * as Zig from "../../src/decompose/Zig.ts"

const step = (command: string, extra: Partial<Step> = {}): Step => ({
  id: "justfile:test:1",
  command,
  cwd: "",
  env: {},
  secrets: [],
  ...extra
})

const closure = (entry: string, files: ReadonlyArray<string>, extra: Partial<Closure> = {}): Closure => ({
  strategy: "zig",
  entries: [entry],
  files: files.map((path) => ({ path, digest: "d" })),
  packages: ["zig@0.17.1"],
  unresolved: [],
  dynamic: [],
  ...extra
})

describe("Zig.soleBuild", () => {
  it("reads the build step of a command that is nothing but zig build", () => {
    expect(Zig.soleBuild("zig build test")).toBe("test")
    expect(Zig.soleBuild("zig build")).toBe("install")
    expect(Zig.soleBuild("set -euo pipefail\nzig build test")).toBe("test")
    expect(Zig.soleBuild("set -e; zig build 'test'")).toBe("test")
  })

  it("reads through bash -c, and leaves out a branch that cannot run", () => {
    // What needlefish's `test` recipe is, with no filter given.
    const recipe =
      `bash -c 'set -euo pipefail\nif [ -n "" ]; then zig build test -Dtest-filter=""; else zig build test; fi'`
    expect(Zig.soleBuild(recipe)).toBe("test")
    expect(Zig.soleBuild(`bash -c 'echo hi; zig build test'`)).toBeUndefined()
  })

  it("refuses a command whose verdict another command can change", () => {
    for (
      const command of [
        // Each of these can pass where `zig build test` fails, or run it only sometimes.
        "zig build test || true",
        "zig build test; echo done",
        "echo start; zig build test",
        "zig build test | tee log",
        "zig build test &",
        "set -e && zig build test",
        `if [ -f go ]; then zig build test; fi`,
        "OPTIMIZE=fast zig build test",
        "OPTIMIZE=fast",
        "set -e"
      ]
    ) expect([command, Zig.soleBuild(command)]).toEqual([command, undefined])
  })

  it("refuses shell it does not read, a build with a flag, a step from a variable, and another program", () => {
    expect(Zig.soleBuild("zig build $(cat step)")).toBeUndefined()
    expect(Zig.soleBuild("zig build test -Doptimize=ReleaseSafe")).toBeUndefined()
    expect(Zig.soleBuild("zig build -Doptimize=ReleaseSafe")).toBeUndefined()
    expect(Zig.soleBuild("zig build $STEP")).toBeUndefined()
    expect(Zig.soleBuild("cargo test")).toBeUndefined()
  })
})

describe("Zig.dress", () => {
  it("names the program and keeps both of Zig's caches in the tool cache", () => {
    const dressed = Zig.dress(step("zig build test"), false)
    expect(dressed.tools).toEqual(["zig"])
    expect(dressed.env).toEqual({
      ZIG_GLOBAL_CACHE_DIR: `${toolCache}/zig/global`,
      ZIG_LOCAL_CACHE_DIR: `${toolCache}/zig/local`
    })
    expect("sealed" in dressed).toBe(false)
  })

  it("keeps what the step already sets, and seals a step that reads nothing but its closure", () => {
    const dressed = Zig.dress(
      step("zig build test", { env: { ZIG_LOCAL_CACHE_DIR: "mine", CI: "1" }, tools: ["zig", "git"] }),
      true
    )
    expect(dressed.env).toEqual({
      CI: "1",
      ZIG_GLOBAL_CACHE_DIR: `${toolCache}/zig/global`,
      ZIG_LOCAL_CACHE_DIR: "mine"
    })
    expect(dressed.tools).toEqual(["git", "zig"])
    expect(dressed.sealed).toBe(true)
  })
})

describe("Zig.split", () => {
  const groups = new Map([["test", ["test-core", "test cli"]], ["check", ["check-a"]], ["docs", []]])
  const closures = new Map([
    ["test-core", closure("test-core", ["src/core.zig", "build.zig", "build.zig"])],
    ["test cli", closure("test cli", ["build.zig", "src/cli.zig"], { directories: ["data/"] })],
    ["check-a", closure("check-a", ["build.zig"])]
  ])

  it("makes one sealed step per named step, each with its own closure", () => {
    const parts = Zig.split(step("set -e\nzig build test", { name: "Test", env: { CI: "1" } }), groups, closures)
    expect(parts).toEqual([
      {
        id: "justfile:test:1:test-core",
        command: "zig build test-core",
        name: "Test (test-core)",
        cwd: "",
        env: { CI: "1", ...Zig.environment },
        secrets: [],
        inputs: ["build.zig", "src/core.zig"],
        from: "justfile:test:1",
        tools: ["zig"],
        sealed: true
      },
      {
        id: "justfile:test:1:test cli",
        // A name the shell would split is quoted.
        command: "zig build 'test cli'",
        name: "Test (test cli)",
        cwd: "",
        env: { CI: "1", ...Zig.environment },
        secrets: [],
        inputs: ["build.zig", "data/**", "src/cli.zig"],
        from: "justfile:test:1",
        tools: ["zig"],
        sealed: true
      }
    ])
    // A step with no name of its own gets none.
    expect(Zig.split(step("zig build test"), groups, closures)?.map((part) => "name" in part)).toEqual([false, false])
  })

  it("leaves the step alone when it is more than one build, or its build step groups nothing", () => {
    expect(Zig.split(step("zig build test || true"), groups, closures)).toBeUndefined()
    expect(Zig.split(step("zig build docs"), groups, closures)).toBeUndefined()
    expect(Zig.split(step("zig build bench"), groups, closures)).toBeUndefined()
    // One named step is the same work under another name.
    expect(Zig.split(step("zig build check"), groups, closures)).toBeUndefined()
  })

  it("leaves the step alone when a named step's closure is missing or incomplete", () => {
    const missing = new Map([["test-core", closures.get("test-core") as Closure]])
    expect(Zig.split(step("zig build test"), groups, missing)).toBeUndefined()
    const open = new Map([
      ...closures,
      ["test cli", closure("test cli", ["build.zig"], { unresolved: [{ from: "src/cli.zig", specifier: "gone.zig" }] })]
    ])
    expect(Zig.split(step("zig build test"), groups, open)).toBeUndefined()
  })
})
