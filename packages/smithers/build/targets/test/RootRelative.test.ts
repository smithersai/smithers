/**
 * Workspace-rooted `//` paths rendered for a child running under a target's
 * `cwd`. One renderer, five rules, one table.
 */
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as NodeBinary from "../src/NodeBinary.ts"
import * as NodeTest from "../src/NodeTest.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Tsconfig from "../src/Tsconfig.ts"

const runtime = Runtime.Node({ version: ">=26.4.0" })

describe("Input.rootRelative", () => {
  it.each([
    [".", "//scripts/check.mjs", "scripts/check.mjs"],
    ["packages/foo", "//scripts/check.mjs", "../../scripts/check.mjs"],
    ["packages/foo", "//packages/foo/run.mjs", "run.mjs"],
    ["packages/foo", "//packages/foo/nested/run.mjs", "nested/run.mjs"],
    ["packages/foo", "//packages/bar/run.mjs", "../bar/run.mjs"],
    ["packages/foo", "scripts/check.mjs", "scripts/check.mjs"],
    [".", "scripts/check.mjs", "scripts/check.mjs"],
    ["./packages/foo", "//tsconfig.base.json", "../../tsconfig.base.json"],
    ["packages/a b", "//with space/x.mjs", "../../with space/x.mjs"],
    ["packages/foo", "//packages/foo", "."]
  ])("renders %s + %s as %s", (cwd, value, expected) => {
    expect(Input.rootRelative(cwd, value)).toBe(expected)
  })
})

describe("rules render a rooted path against their own cwd", () => {
  it("NodeBinary", () => {
    const target = NodeBinary.runArgv(
      NodeBinary.Attrs.make({
        runtime,
        entry: Input.file("//scripts/check.mjs"),
        args: [],
        srcs: [],
        deps: [],
        cwd: "packages/foo"
      })
    )
    expect(target).toContain("../../scripts/check.mjs")
  })

  it("NodeTest", () => {
    const argv = NodeTest.runArgv(
      NodeTest.Attrs.make({
        runtime,
        runner: { name: "entrypoint", entry: Input.file("//scripts/check.mjs"), args: [] },
        srcs: [],
        deps: [],
        cwd: "packages/foo"
      })
    )
    expect(argv).toContain("../../scripts/check.mjs")
  })

  it("Tsconfig extends", () => {
    const rendered = Tsconfig.render(
      Tsconfig.Attrs.make({
        extends: Input.file("//tsconfig.base.json"),
        cwd: "packages/foo"
      })
    )
    expect(JSON.parse(rendered)["extends"]).toBe("../../tsconfig.base.json")
  })

  it("Tsconfig extends from the workspace root keeps the explicit relative prefix", () => {
    const rendered = Tsconfig.render(
      Tsconfig.Attrs.make({ extends: Input.file("//tsconfig.base.json"), cwd: "." })
    )
    expect(JSON.parse(rendered)["extends"]).toBe("./tsconfig.base.json")
  })
})

describe("PackageManager.dlx honours the declared executable", () => {
  it("renders bun dlx through the executable rather than a hard-coded bunx", () => {
    const bun = PackageManager.BunPackages({
      runtime: Runtime.Bun({ version: ">=1.4.0" }),
      executable: "/opt/shim/bun"
    })
    expect(PackageManager.dlx(bun, ["jsr", "publish"])).toEqual(["/opt/shim/bun", "x", "jsr", "publish"])
  })
})
