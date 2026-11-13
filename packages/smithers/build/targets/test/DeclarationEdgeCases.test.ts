import { describe, expect, it } from "vitest"
import * as Agent from "../src/AgentTarget.ts"
import * as Cargo from "../src/Cargo.ts"
import * as ExecSandbox from "../src/ExecSandbox.ts"
import * as Factory from "../src/Factory.ts"
import * as Home from "../src/Home.ts"
import * as Input from "../src/Input.ts"
import * as Defaults from "../src/PackageDefaults.ts"
import * as Runtime from "../src/Runtime.ts"
import * as TsBuild from "../src/TsBuild.ts"
import { Sandbox } from "../src/WorkspaceDeclaration.ts"

describe("public declaration edge cases", () => {
  it("reports a thrown non-Error when JSON input coercion fails", () => {
    const text = {
      [Symbol.toPrimitive]: () => {
        throw "fixture coercion failure"
      }
    } as never
    expect(Factory.parseProjection(text)).toBe("the factory projection is not JSON: fixture coercion failure")
    expect(Home.parse(text)).toBe("the homepage is not JSON: fixture coercion failure")
  })

  it("rejects a default-target declaration with a non-string exclusion member", () => {
    const declaration = Defaults.make({ directories: "packages/*", macro: () => ({}) })
    expect(Defaults.isPackageDefaults({
      ...declaration,
      directories: { ...declaration.directories, exclude: [42] }
    })).toBe(false)
  })

  it("does not guess Cargo metadata or outputs for a non-object attrs value", () => {
    expect(Cargo.binaries(null)).toEqual([])
    expect(Cargo.appSetFilter(null)).toBeUndefined()
  })

  it("does not invent an entry point when a TsBuild declares no entries", () => {
    const attrs = TsBuild.Attrs.make({
      srcs: [],
      entries: [],
      deps: [],
      tsconfig: Input.file("tsconfig.json"),
      tool: { name: "tsc" },
      format: "esm",
      outDir: "dist"
    })
    expect(TsBuild.distributionLayout(attrs)).toEqual([
      { format: "esm", directory: "dist/esm", entry: null, declaration: null }
    ])
  })

  it("refuses an explicit bubblewrap plan whose declared link leaves the workspace", () => {
    const host: ExecSandbox.Host = {
      platform: "linux",
      executable: () => "/usr/bin/bwrap",
      exists: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      realpath: (path) => path,
      uid: 501,
      gid: 20
    }
    const planned = ExecSandbox.plan(
      {
        policy: {},
        mechanism: Sandbox.Bubblewrap(),
        reads: [],
        writes: [],
        links: [{ path: "link", target: "../outside" }]
      },
      { workspaceRoot: "/virtual/workspace", cwd: "/virtual/workspace", tmp: "/virtual/tmp" },
      host
    )
    expect(ExecSandbox.isUnenforceable(planned)).toBe(true)
    expect(planned).toMatchObject({ missing: "workspace link target" })
    expect((planned as { message: string }).message).toContain("A confined target never runs unconfined")
  })
})

it("projects an explicit agent without inventing a declaring package directory", () => {
  const agent = Agent.Agents["reviewer"]
  expect(Agent.lintPayload({
    agent,
    prompt: Input.file("prompts/review.md"),
    data: []
  }, { sourceFile: undefined, packageDirectory: undefined })).toEqual({
    agent,
    promptPath: "prompts/review.md",
    diffs: [],
    fixes: [],
    mode: "check"
  })
})

it("treats an explicitly absent Node options value as no declared options", () => {
  const runtime = Runtime.Node({ version: ">=26.4.0", imports: ["./loader.mjs"] })
  expect(Runtime.environment(runtime, { NODE_OPTIONS: undefined as never })).toEqual({
    NODE_OPTIONS: `${Runtime.importTokenPrefix}./loader.mjs}`
  })
})
