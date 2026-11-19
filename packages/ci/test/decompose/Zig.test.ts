import { describe, expect, it } from "vitest"
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

  it("refuses shell it does not read, a step from a variable, and another program", () => {
    expect(Zig.soleBuild("zig build $(cat step)")).toBeUndefined()
    expect(Zig.soleBuild("zig build $STEP")).toBeUndefined()
    expect(Zig.soleBuild("cargo test")).toBeUndefined()
    expect(Zig.soleBuild("zig test src/main.zig")).toBeUndefined()
  })
})

describe("Zig.sole", () => {
  it("keeps the flags that only change how the run is reported or how much runs at once", () => {
    expect(Zig.sole("zig build test")).toEqual({ step: "test", flags: [] })
    expect(Zig.sole("zig build test --summary all")).toEqual({ step: "test", flags: ["--summary", "all"] })
    // A flag may come before the step, and a build with no step is `install`.
    expect(Zig.sole("zig build --summary all test")).toEqual({ step: "test", flags: ["--summary", "all"] })
    expect(Zig.sole("zig build --color off")).toEqual({ step: "install", flags: ["--color", "off"] })
    expect(Zig.sole("set -e\nzig build test -j4 --verbose --error-style minimal --multiline-errors newline")).toEqual({
      step: "test",
      flags: ["-j4", "--verbose", "--error-style", "minimal", "--multiline-errors", "newline"]
    })
    expect(Zig.sole("zig build test --test-timeout 30s --seed 7 -freference-trace=8 -fno-reference-trace")).toEqual({
      step: "test",
      flags: ["--test-timeout", "30s", "--seed", "7", "-freference-trace=8", "-fno-reference-trace"]
    })
    expect(Zig.sole("zig build -freference-trace check")).toEqual({ step: "check", flags: ["-freference-trace"] })
  })

  it("refuses a flag that can change what is built or which steps run", () => {
    for (
      const command of [
        "zig build test -Doptimize=ReleaseSafe",
        "zig build -Doptimize=ReleaseSafe",
        "zig build test --release=fast",
        "zig build test --maxrss 1000000",
        "zig build test --skip-oom-steps",
        "zig build test --fuzz",
        "zig build run -- --port 80",
        // Two build steps are two builds, and a flag that needs a value has none.
        "zig build test docs",
        "zig build test --summary",
        "zig build test --summary=all"
      ]
    ) expect([command, Zig.sole(command)]).toEqual([command, undefined])
  })
})

describe("Zig.runs", () => {
  it("is true for a step that starts zig in the root, whatever else it runs", () => {
    for (
      const command of [
        "zig build test",
        "zig build test --summary all",
        "zig build -Doptimize=ReleaseSafe test",
        "zig test src/main.zig",
        "zig fmt --check . && zig build test -Dtest-filter=rlp",
        "make deps; zig build",
        "CI=1 zig build test",
        "zig build test | tee log",
        "set -euo pipefail\nzig build test --summary all",
        `bash -c 'set -euo pipefail\nif [ -n "rlp" ]; then zig build test -Dtest-filter="rlp"; else zig build test; fi'`,
        "zig build test -Doptimize=$MODE"
      ]
    ) expect([command, Zig.runs(step(command))]).toEqual([command, true])
    // The step may start in the root under another spelling, or in a directory under it.
    for (const cwd of [".", "./", "tools/gen", "./tools/gen/"]) {
      expect([cwd, Zig.runs(step("zig build test --summary all", { cwd }))]).toEqual([cwd, true])
    }
  })

  it("is false when no command is zig", () => {
    for (
      const command of [
        "cargo test",
        "echo zig build test",
        "./zig-out/bin/app --version",
        "CI=1",
        "bash -c 'npm test'"
      ]
    ) expect([command, Zig.runs(step(command))]).toEqual([command, false])
  })

  it("is false when where Zig starts cannot be named from the root", () => {
    for (const cwd of ["/opt/project", "~/project", "../sibling", "tools/../..", "${{ matrix.directory }}", "$DIR"]) {
      expect([cwd, Zig.runs(step("zig build test --summary all", { cwd }))]).toEqual([cwd, false])
    }
    expect(Zig.runs(step("cd tools/gen && zig build test"))).toBe(false)
    expect(Zig.runs(step("pushd tools/gen; zig build; popd"))).toBe(false)
    expect(Zig.runs(step("bash -c 'cd tools/gen && zig build test'"))).toBe(false)
  })

  it("is false when the step names Zig's cache, which it expects beside build.zig", () => {
    expect(Zig.runs(step("zig build test --summary all && ls .zig-cache/o"))).toBe(false)
    expect(Zig.runs(step("zig build --cache-dir .zig-cache test"))).toBe(false)
  })

  it("is false when a program is named by a variable, or the shell is more than is read", () => {
    expect(Zig.runs(step("$ZIG build test"))).toBe(false)
    expect(Zig.runs(step("zig build test; $AFTER"))).toBe(false)
    expect(Zig.runs(step("for mode in Debug ReleaseSafe; do zig build test -Doptimize=$mode; done"))).toBe(false)
    expect(Zig.runs(step("bash -c 'zig build $(cat step)'"))).toBe(false)
  })
})

describe("Zig.dress", () => {
  it("keeps both of Zig's caches in the tool cache, and names no inputs", () => {
    const dressed = Zig.dress(step("zig build test"))
    expect(dressed).toEqual({
      ...step("zig build test"),
      env: { ZIG_GLOBAL_CACHE_DIR: `${toolCache}/zig/global`, ZIG_LOCAL_CACHE_DIR: `${toolCache}/zig/local` }
    })
  })

  it("gives a step that starts under the root the way back up to the tool cache", () => {
    expect(Zig.dress(step("zig build test", { cwd: "tools/gen" })).env).toEqual({
      ZIG_GLOBAL_CACHE_DIR: `../../${toolCache}/zig/global`,
      ZIG_LOCAL_CACHE_DIR: `../../${toolCache}/zig/local`
    })
    expect(Zig.dress(step("zig build test", { cwd: "./project/" })).env).toEqual({
      ZIG_GLOBAL_CACHE_DIR: `../${toolCache}/zig/global`,
      ZIG_LOCAL_CACHE_DIR: `../${toolCache}/zig/local`
    })
    // Where the step starts cannot be named: the caches are given as from the root, as for any other step.
    expect(Zig.dress(step("zig build test", { cwd: "$DIR" })).env).toEqual(Zig.environment)
  })

  it("keeps what the step already sets", () => {
    const dressed = Zig.dress(step("zig build test", { env: { ZIG_LOCAL_CACHE_DIR: "mine", CI: "1" } }))
    expect(dressed.env).toEqual({
      CI: "1",
      ZIG_GLOBAL_CACHE_DIR: `${toolCache}/zig/global`,
      ZIG_LOCAL_CACHE_DIR: "mine"
    })
  })
})

describe("Zig.split", () => {
  const groups = new Map([["test", ["test-core", "test cli"]], ["check", ["check-a"]], ["docs", []]])

  it("makes one step per named step, each with Zig's caches, no inputs and leave to run beside the others", () => {
    const parts = Zig.split(step("set -e\nzig build test", { name: "Test", env: { CI: "1" } }), groups)
    expect(parts).toEqual([
      {
        id: "justfile:test:1:test-core",
        command: "zig build test-core",
        name: "Test (test-core)",
        cwd: "",
        env: { CI: "1", ...Zig.environment },
        secrets: [],
        from: "justfile:test:1",
        // One build ran the named steps at the same time, so the steps still may.
        atOnce: true
      },
      {
        id: "justfile:test:1:test cli",
        // A name the shell would split is quoted.
        command: "zig build 'test cli'",
        name: "Test (test cli)",
        cwd: "",
        env: { CI: "1", ...Zig.environment },
        secrets: [],
        from: "justfile:test:1",
        // One build ran the named steps at the same time, so the steps still may.
        atOnce: true
      }
    ])
    // A step with no name of its own gets none.
    expect(Zig.split(step("zig build test"), groups)?.map((part) => "name" in part)).toEqual([false, false])
  })

  it("gives each named step the flags the step gave", () => {
    const parts = Zig.split(step("zig build --color off test --summary all"), groups)
    expect(parts?.map((part) => part.command)).toEqual([
      "zig build test-core --color off --summary all",
      "zig build 'test cli' --color off --summary all"
    ])
  })

  it("leaves a step that starts under the root alone: the named steps are those of the root's build", () => {
    expect(Zig.split(step("zig build test", { cwd: "tools/gen" }), groups)).toBeUndefined()
    expect(Zig.split(step("zig build test", { cwd: "." }), groups)?.length).toBe(2)
  })

  it("leaves the step alone when it is more than one build, or its build step groups fewer than two", () => {
    expect(Zig.split(step("zig build test || true"), groups)).toBeUndefined()
    expect(Zig.split(step("zig build docs"), groups)).toBeUndefined()
    expect(Zig.split(step("zig build bench"), groups)).toBeUndefined()
    // One named step is the same work under another name.
    expect(Zig.split(step("zig build check"), groups)).toBeUndefined()
  })
})
