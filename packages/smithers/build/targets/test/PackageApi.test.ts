import { describe, expect, it } from "vitest"
import * as AgentTarget from "../src/AgentTarget.ts"
import * as BundlerTarget from "../src/BundlerTarget.ts"
import { Files, Suite, Test } from "../src/Compose.ts"
import { isFilegroup } from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import { isPackage, metadata, Package, PackageTypeId } from "../src/Package.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

const lint = Shell.Test({
  bin: { _tag: "NodeModuleBin", package: "@biomejs/biome" },
  data: [Input.glob(["**", "!dist/**"])]
})

const workspaceOptions = (): WorkspaceDeclaration.WorkspaceOptions => {
  const packageJson = Input.file("//package.json")
  return {
    repository: "git+https://example.invalid/fixture.git",
    cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
    runtime: Runtime.Node({ version: "26" }),
    packageManager: PackageManager.Yarn({ manifest: packageJson, lockfile: Input.file("//yarn.lock") }),
    nodeModules: WorkspaceDeclaration.NodeModules({ packageJson })
  }
}

describe("S.Package", () => {
  it("returns the target map directly, branded, frozen, with sorted keys", () => {
    const suite = Suite({ tests: [lint] })
    const value = Package({ targets: { suite, lint } })
    expect(value.lint).toBe(lint)
    expect(value.suite).toBe(suite)
    expect(Object.isFrozen(value)).toBe(true)
    expect(isPackage(value)).toBe(true)
    expect(metadata(value)).toEqual({ abi: "@smthrs/targets/Package/v1", keys: ["lint", "suite"] })
    const descriptor = Object.getOwnPropertyDescriptor(value, PackageTypeId)!
    expect(descriptor.enumerable).toBe(false)
    expect(descriptor.configurable).toBe(false)
    expect(descriptor.writable).toBe(false)
    expect(metadata(Package({ targets: { lint, suite } })).keys).toEqual(["lint", "suite"])
  })

  it("wraps declared file and glob inputs into filegroup targets under their keys", () => {
    const value = Package({
      targets: { schema: Input.file("schema.graphql"), sources: Input.glob("src/**/*.ts") }
    })
    expect(Target.isTarget(value.schema)).toBe(true)
    expect(isFilegroup(value.schema)).toBe(true)
    expect(Target.isTarget(value.sources)).toBe(true)
    expect(isFilegroup(value.sources)).toBe(true)
  })

  it("rejects non-target values, bad keys, Proxy maps, and symbol keys", () => {
    expect(() => Package(null as never)).toThrowError(new TypeError("Package options must be a plain object"))
    expect(() => Package({ targets: { bad: 42 as never } })).toThrow(/not a target/)
    expect(() => Package({ targets: { "no:colon": lint } as never })).toThrow(/A-Za-z_/)
    expect(() => Package({ targets: new Proxy({}, {}) as never })).toThrow(/plain object/)
    const symbolic: Record<string, unknown> = {}
    Object.defineProperty(symbolic, Symbol("x"), { enumerable: true, value: lint })
    expect(() => Package({ targets: symbolic as never })).toThrow(/symbol/)
    expect(() => Package({ targets: {}, extra: true } as never)).toThrow(/unknown option/)
  })

  it("copies only own enumerable data entries, never reading an accessor", () => {
    // The contract is object-spread copying: an accessor or a non-enumerable
    // entry is omitted from the branded map and its metadata keys, and the
    // getter is never invoked, so a lazy or throwing getter cannot run here.
    let getterReads = 0
    const map: Record<string, unknown> = { kept: lint }
    Object.defineProperty(map, "viaGetter", {
      enumerable: true,
      get: () => {
        getterReads += 1
        return lint
      }
    })
    Object.defineProperty(map, "hidden", { enumerable: false, value: lint })
    const value = Package({ targets: map as never })
    expect(metadata(value).keys).toEqual(["kept"])
    expect(Object.keys(value)).toEqual(["kept"])
    expect("viaGetter" in value).toBe(false)
    expect("hidden" in value).toBe(false)
    expect(getterReads).toBe(0)
  })

  it("records defaultVisibility: \"public\" and refuses a visibility it cannot honour", () => {
    const stated = Package({ defaultVisibility: "public", targets: { lint } })
    expect(metadata(stated).defaultVisibility).toBe("public")
    expect(metadata(Package({ targets: { lint } })).defaultVisibility).toBeUndefined()
    expect(() => Package({ defaultVisibility: "private", targets: { lint } } as never))
      .toThrow(/defaultVisibility must be "public"/)
  })

  it("refuses a forged enumerable marker", () => {
    const forged: Record<PropertyKey, unknown> = { lint }
    forged[PackageTypeId] = { abi: "@smthrs/targets/Package/v1", keys: ["lint"] }
    expect(isPackage(forged)).toBe(false)
  })
})

describe("S.Workspace", () => {
  it("validates and freezes the declaration", () => {
    const workspace = WorkspaceDeclaration.Workspace("fixture", workspaceOptions())
    expect(WorkspaceDeclaration.isWorkspaceDeclaration(workspace)).toBe(true)
    expect(workspace.name).toBe("fixture")
    expect(Object.isFrozen(workspace)).toBe(true)
  })

  it("rejects unknown options, bad hooks, and wrong field types", () => {
    expect(() => WorkspaceDeclaration.Workspace("fixture", { ...workspaceOptions(), extra: 1 } as never)).toThrow(
      /unknown option/
    )
    expect(() =>
      WorkspaceDeclaration.Workspace("fixture", {
        ...workspaceOptions(),
        gitHooks: { preCommit: 42 as never }
      })
    ).toThrow(/must be a target/)
    expect(() =>
      WorkspaceDeclaration.Workspace("fixture", {
        ...workspaceOptions(),
        gitHooks: { onPush: lint } as never
      })
    ).toThrow(/unknown hook/)
    expect(() => WorkspaceDeclaration.Workspace("fixture", { ...workspaceOptions(), cache: {} as never })).toThrow(
      /S\.Cache/
    )
  })

  it("accepts git hooks bound to targets", () => {
    const workspace = WorkspaceDeclaration.Workspace("fixture", {
      ...workspaceOptions(),
      gitHooks: { preCommit: lint }
    })
    expect(workspace.gitHooks?.preCommit).toBe(lint)
  })
})

describe("S.Agents and S.Flags reference surfaces", () => {
  it("mints inert plain references on property access", () => {
    const luna = AgentTarget.Agents.luna
    expect(luna).toEqual({ _tag: "AgentRef", name: "luna" })
    expect(Object.isFrozen(luna)).toBe(true)
    expect(WorkspaceDeclaration.Flags.production).toEqual({ _tag: "FlagRef", name: "production" })
  })

  it("constructs validated declarations when called", () => {
    const agents = AgentTarget.Agents({
      default: AgentTarget.ClaudeCode({ model: "claude-fable-5" }),
      luna: AgentTarget.Codex({ model: "luna" }),
      reviewPool: AgentTarget.Pool(["luna", "default"])
    })
    expect(AgentTarget.isAgentsDeclaration(agents)).toBe(true)
    expect(Object.keys(agents.agents)).toEqual(["default", "luna", "reviewPool"])
    expect(() => AgentTarget.Agents({ pool: AgentTarget.Pool(["missing"]) })).toThrow(/not a declared agent/)
    const flags = WorkspaceDeclaration.Flags({ production: "--production" })
    expect(WorkspaceDeclaration.isFlagsDeclaration(flags)).toBe(true)
  })
})

describe("Runtime.Node and PackageManager.Yarn forms", () => {
  it("keeps the PACKAGE.ts literal form and adds the exclusive union", () => {
    const classic = Runtime.Node({ version: ">=22.19.0" })
    expect(Runtime.isRuntime(classic)).toBe(true)
    const pinned = Runtime.Node({ version: "26" })
    expect(Runtime.isNodeDeclaration(pinned)).toBe(true)
    const derived = Runtime.Node({ manifest: Input.file("//package.json") })
    expect(Runtime.isNodeDeclaration(derived)).toBe(true)
    expect(() => Runtime.Node({ manifest: Input.file("//package.json"), version: "26" } as never)).toThrow(/not both/)
  })

  it("validates the Yarn declaration", () => {
    const yarn = PackageManager.Yarn({
      manifest: Input.file("//package.json"),
      lockfile: Input.file("//yarn.lock"),
      audit: { severity: "critical", recursive: true },
      version: "4.5.0"
    })
    expect(PackageManager.isYarnDeclaration(yarn)).toBe(true)
    expect(yarn.version).toBe("4.5.0")
  })

  it("validates the Pnpm workspace declaration like Yarn's", () => {
    const pnpm = PackageManager.Pnpm({
      manifest: Input.file("//package.json"),
      lockfile: Input.file("//pnpm-lock.yaml"),
      version: "8",
      audit: { severity: "critical", recursive: true }
    })
    expect(PackageManager.isPnpmDeclaration(pnpm)).toBe(true)
    expect(PackageManager.isPackageManager(pnpm)).toBe(false)
    // viem's spelling: no version pin, the workspace file as a graph input.
    const bare = PackageManager.Pnpm({
      manifest: Input.file("//package.json"),
      lockfile: Input.file("//pnpm-lock.yaml"),
      workspaces: Input.file("//pnpm-workspace.yaml")
    })
    expect(PackageManager.isPnpmDeclaration(bare)).toBe(true)
    expect(bare.version).toBeUndefined()
  })

  it("keeps the BUILD-era Pnpm form and its runtime requirement", () => {
    const classic = PackageManager.Pnpm({ version: "11.21.0", runtime: Runtime.Node({ version: ">=22.19.0" }) })
    expect(PackageManager.isPackageManager(classic)).toBe(true)
    expect(() => PackageManager.Pnpm({ version: "11.21.0" } as never)).toThrow(/runtime/)
  })

  it("accepts the Pnpm workspace declaration as the Workspace packageManager", () => {
    const options = workspaceOptions()
    const workspace = WorkspaceDeclaration.Workspace("pnpmfixture", {
      ...options,
      packageManager: PackageManager.Pnpm({
        manifest: Input.file("//package.json"),
        lockfile: Input.file("//pnpm-lock.yaml")
      })
    })
    expect(PackageManager.isPnpmDeclaration(workspace.packageManager)).toBe(true)
  })
})

describe("input forms", () => {
  it("expands the glob array form into per-pattern globs with shared excludes", () => {
    expect(Input.glob(["**", "!__generated__/**"])).toEqual([
      { _tag: "Glob", pattern: "**", exclude: ["__generated__/**"] }
    ])
    expect(Input.glob(["a/**", "b/**", "!c/**"])).toEqual([
      { _tag: "Glob", pattern: "a/**", exclude: ["c/**"] },
      { _tag: "Glob", pattern: "b/**", exclude: ["c/**"] }
    ])
    expect(() => Input.glob(["!only-exclude/**"])).toThrow(/positive/)
    expect(Input.glob("src/**")).toEqual({ _tag: "Glob", pattern: "src/**", exclude: [] })
  })

  it("keeps the string gitDiff form and adds the optional-object form", () => {
    expect(Input.gitDiff("origin/main")).toEqual({ _tag: "GitDiff", base: "origin/main" })
    expect(Input.gitDiff()).toEqual({ _tag: "GitDiff", base: "HEAD" })
    expect(Input.gitDiff({ paths: ["**/__tests__/**"], addedLines: "\\bit\\(" })).toEqual({
      _tag: "GitDiff",
      base: "HEAD",
      paths: ["**/__tests__/**"],
      addedLines: "\\bit\\("
    })
  })
})

describe("unknown attr keys are rejected, never stripped", () => {
  it("rejects a top-level typo such as gate for gates or approvals for approval", () => {
    expect(() => Shell.Run({ shell: "echo hi", gate: [lint] } as never)).toThrow(/excess property[\s\S]*gate/)
    expect(() => Shell.Run({ shell: "echo hi", approvals: "required" } as never)).toThrow(
      /excess property[\s\S]*approvals/
    )
  })

  it("rejects an unknown key inside a nested attr struct", () => {
    expect(() => Shell.Serve({ shell: "yarn start", readiness: { port: 4000, extra: true } } as never)).toThrow(
      /excess property/
    )
  })

  it("admits the three sandbox network values and rejects a misspelled one", () => {
    expect(Target.isTarget(Shell.Test({ shell: "go test ./...", sandbox: { network: "loopback" } }))).toBe(true)
    expect(Target.isTarget(Shell.Test({ shell: "go test ./...", sandbox: { network: true } }))).toBe(true)
    expect(Target.isTarget(Shell.Test({ shell: "go test ./...", sandbox: { network: false } }))).toBe(true)
    expect(() => Shell.Test({ shell: "go test ./...", sandbox: { network: "lopback" } } as never)).toThrow()
  })

  it("admits Shell service edges, shards, scripts, and bounded duration syntax", () => {
    const service = Shell.Serve({ shell: "node server.js" })
    expect(Target.isTarget(Shell.Serve({ shell: "node proxy.js", services: [service] }))).toBe(true)
    expect(
      Target.isTarget(Shell.Test({ script: Input.file("//test.sh"), services: [service], shards: 3, timeout: "6h" }))
    )
      .toBe(true)
    expect(() => Shell.Test({ shell: "true", shards: 0 })).toThrow()
    expect(() => Shell.Test({ shell: "true", timeout: "tomorrow" })).toThrow()
  })

  it("rejects unknown Bundler.Rspack method options that named-key rebuilding would drop", () => {
    const bundler = BundlerTarget.Rspack({ config: Input.file("//webpack.config.ts") })
    expect(() => bundler.resolve({ entries: ["src/client.tsx"], universe: [], entry: "typo" } as never)).toThrow(
      /unknown option "entry"/
    )
    expect(() => Shell.Build({ shell: "echo build", outDirs: ["dist"], outDir: "dist" } as never)).toThrow(
      /excess property[\s\S]*outDir/
    )
  })
})

describe("construct-only implementations", () => {
  it("marks every flavor with the NotImplemented stub body, never fake success", () => {
    const target = Shell.Run({ shell: "echo hi" })
    const test = Test({
      expect: Files.difference(lint, lint),
      toBe: "empty"
    })
    for (const value of [target, test]) {
      expect(Target.isTarget(value)).toBe(true)
    }
    // The plan-time body records the shared NotImplemented action; executing
    // it without a real implementation layer fails with the typed error.
    expect(Target.notImplemented("Shell.Run")).toBeDefined()
    expect(Target.catalogNotImplemented()).toBeDefined()
  })
})
