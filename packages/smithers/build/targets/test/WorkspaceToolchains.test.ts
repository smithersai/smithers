/**
 * The `toolchains` layer list on `S.Workspace`.
 *
 * A Cargo workspace has no Node runtime, no package manager, and no
 * node_modules tree, so requiring the JS trio would make every Rust repo
 * declare three lies. The list generalizes the pair: a workspace states the
 * layers its targets resolve against, and the JS trio stays required for a
 * workspace that declares no layers at all.
 */
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

const cache = WorkspaceDeclaration.Cache({ directory: ".flows" })
const rust = RustToolchain.Toolchain({ workspace: Input.file("//Cargo.toml"), channel: "1.91" })
const runtime = Runtime.Node({ version: ">=26.4.0" })
const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime })
const nodeModules = WorkspaceDeclaration.NodeModules({ packageJson: Input.file("//package.json") })

describe("Workspace toolchains", () => {
  it("accepts a toolchain-only workspace with no JS trio", () => {
    const workspace = WorkspaceDeclaration.Workspace("aomi-sdk", {
      repository: "git+https://github.com/aomi-labs/aomi-sdk.git",
      cache,
      toolchains: [rust],
      host: WorkspaceDeclaration.Host({ bins: ["cargo", "python3", "rustup"] })
    })
    expect(workspace.toolchains).toEqual([rust])
    expect(workspace.runtime).toBeUndefined()
    expect(workspace.packageManager).toBeUndefined()
    expect(workspace.nodeModules).toBeUndefined()
    expect(WorkspaceDeclaration.rustToolchain(workspace)).toEqual(rust)
  })

  it("keeps the JS trio required when no toolchain layer is declared", () => {
    expect(() =>
      WorkspaceDeclaration.Workspace("force", { repository: "git+https://example.invalid/force.git", cache } as never)
    ).toThrow(/runtime/)
    const js = WorkspaceDeclaration.Workspace("force", {
      repository: "git+https://example.invalid/force.git",
      cache,
      runtime,
      packageManager,
      nodeModules
    })
    expect(js.runtime).toEqual(runtime)
    expect(js.packageManager).toEqual(packageManager)
    expect(js.nodeModules).toEqual(nodeModules)
    expect(js.toolchains).toEqual([])
    expect(WorkspaceDeclaration.rustToolchain(js)).toBeUndefined()
  })

  it("admits a mixed workspace that declares both", () => {
    const both = WorkspaceDeclaration.Workspace("mixed", {
      repository: "git+https://example.invalid/mixed.git",
      cache,
      runtime,
      packageManager,
      nodeModules,
      toolchains: [rust]
    })
    expect(both.runtime).toEqual(runtime)
    expect(WorkspaceDeclaration.rustToolchain(both)).toEqual(rust)
  })

  it("refuses a toolchains list that is not a list of layer declarations", () => {
    const options = { repository: "git+https://example.invalid/x.git", cache }
    expect(() => WorkspaceDeclaration.Workspace("x", { ...options, toolchains: [] } as never))
      .toThrow(/runtime/)
    expect(() => WorkspaceDeclaration.Workspace("x", { ...options, toolchains: rust } as never))
      .toThrow(/toolchains must be an array/)
    expect(() => WorkspaceDeclaration.Workspace("x", { ...options, toolchains: [RustToolchain.Pinned({})] } as never))
      .toThrow(/toolchain layer declaration/)
  })
})
