import { Smithers as S } from "@smthrs/targets"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { validateWorkspaceModule } from "../src/WorkspaceLoader.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const fixture = async (explicit: boolean) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-no-toolchain-")))
  roots.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("docs", {
  repository: "git+https://example.invalid/docs.git",
  cache: S.Cache({ directory: ".flows" }),
  discovery: { prune: ["Archive"] },
  ${explicit ? "toolchains: []," : ""}
  host: S.Host({ bins: ["sh"] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  docs: S.Filegroup({ srcs: [S.file("README.md")] }),
  check: S.Shell.Test({ bin: S.Host.bin("sh"), args: ["-c", "printf TOOLCHAIN_FREE_EXECUTED"] }),
  javascript: S.Shell.Test({ bin: S.Runtime.bin, args: ["--version"] }),
  manager: S.Shell.Test({ bin: S.PackageManager.bin, args: ["--version"] }),
  rust: S.Shell.Test({ bin: { _tag: "CargoBin" }, args: ["--version"] })
} })`
  )
  await write(root, "README.md", "# Docs only\n")
  await write(root, "Archive/PACKAGE.ts", "throw new Error('pruned archive was evaluated')")
  return root
}

const discover = async (root: string) => {
  const workspace = await PackageLoader.loadWorkspaceDeclaration(root, "WORKSPACE.ts")
  return PackageDiscovery.discover(root, { prune: workspace.discovery?.prune })
}

describe("toolchain-free workspaces (#4249)", () => {
  it.each([false, true])("loads a docs declaration (explicit empty toolchains=%s)", (explicit) => {
    const workspace = S.Workspace("docs", {
      repository: "git+https://example.invalid/docs.git",
      cache: S.Cache({ directory: ".flows" }),
      discovery: { prune: ["Archive"] },
      ...(explicit ? { toolchains: [] } : {})
    })
    expect(validateWorkspaceModule({ Workspace: workspace }, "WORKSPACE.ts")).toBe(workspace)
    expect(workspace.runtime).toBeUndefined()
    expect(workspace.packageManager).toBeUndefined()
    expect(workspace.nodeModules).toBeUndefined()
    expect(workspace.environment).toBeUndefined()
    expect(workspace.toolchains).toEqual([])
    expect(Object.isFrozen(workspace.toolchains)).toBe(true)
  })

  it.each([1, 2, 3, 4, 5, 6])("still refuses a partial Node declaration (mask=%s)", (mask) => {
    const runtime = S.Runtime.Node({ version: ">=22" })
    const packageManager = S.PackageManager.Pnpm({
      manifest: S.file("//package.json"),
      lockfile: S.file("//pnpm-lock.yaml")
    })
    const nodeModules = S.Npm.NodeModules({ packageJson: S.file("//package.json") })
    expect(() =>
      S.Workspace("partial", {
        repository: "git+https://example.invalid/docs.git",
        cache: S.Cache({ directory: ".flows" }),
        ...(mask & 1 ? { runtime } : {}),
        ...(mask & 2 ? { packageManager } : {}),
        ...(mask & 4 ? { nodeModules } : {})
      })
    ).toThrow("Workspace runtime, packageManager, and nodeModules must be declared together")
  })

  it.each([null, 7, {}, { _tag: 7 }])("still refuses an invalid toolchain entry %j", (toolchain) => {
    expect(() =>
      S.Workspace("invalid", {
        repository: "git+https://example.invalid/docs.git",
        cache: S.Cache({ directory: ".flows" }),
        toolchains: [toolchain] as never
      })
    ).toThrow("Workspace toolchains entries must each be a toolchain layer declaration")
  })

  it.each([false, true])("discovers, lists and executes without a manifest (explicit=%s)", async (explicit) => {
    const root = await fixture(explicit)
    const discovery = await discover(root)
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts"])
    expect(discovery.pruned).toContain("Archive")
    const index = PackageIndex.make(await PackageLoader.load(discovery), root)
    const plan = await PackageExec.plan({ index, cacheDirectory: ".flows", verb: "test", patterns: ["//:check"] })
    expect([...plan.nodes.keys()]).toEqual(["//:check"])
    expect(plan.nodes.get("//:check")?.refusal).toBeUndefined()
    const listing = await serve(root, ["targets", "//..."])
    expect(listing.exitCode, listing.output + listing.logs).toBe(0)
    for (const label of ["//:docs", "//:check", "//:javascript", "//:manager", "//:rust"]) {
      expect(listing.output).toContain(label)
    }
    const result = await serve(root, ["test", "//:check", "--no-cache", "--jobs", "1"])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(result.output + result.logs).toContain("TOOLCHAIN_FREE_EXECUTED")
    expect(result.output + result.logs).toContain("//:check  ran")
    await expect(Fs.stat(Path.join(root, "package.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(Fs.stat(Path.join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([
    ["javascript", "workspace declares no JavaScript runtime"],
    ["manager", "workspace declares no Node package manager"],
    ["rust", "the workspace declares no Rust toolchain layer"]
  ])("refuses only the selected %s target with a missing-toolchain diagnostic", async (name, message) => {
    const root = await fixture(false)
    const index = PackageIndex.make(await PackageLoader.load(await discover(root)), root)
    const plan = await PackageExec.plan({ index, cacheDirectory: ".flows", verb: "test", patterns: [`//:${name}`] })
    expect([...plan.nodes.keys()]).toEqual([`//:${name}`])
    expect(plan.nodes.get(`//:${name}`)?.refusal).toContain(message)
    const result = await serve(root, ["test", `//:${name}`, "--no-cache", "--jobs", "1"])
    expect(result.exitCode, result.output + result.logs).toBe(1)
    expect(result.output + result.logs).toContain(message)
    expect(result.output + result.logs).not.toContain("TOOLCHAIN_FREE_EXECUTED")
  })
})
