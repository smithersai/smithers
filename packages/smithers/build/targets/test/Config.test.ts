import { describe, expect, it } from "vitest"
import * as Config from "../src/Config.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

describe("Workspace", () => {
  it("defaults the cache directory to .flows and gitignored to false", () => {
    const config = Config.Workspace()
    expect(config.cacheDirectory).toBe(".flows")
    expect(config.gitignored).toBe(false)
    expect(Config.defaultCacheDirectory).toBe(".flows")
  })

  it("keeps a declared directory and gitignored flag", () => {
    const config = Config.Workspace({ cacheDirectory: "build/cache", gitignored: true })
    expect(config.cacheDirectory).toBe("build/cache")
    expect(config.gitignored).toBe(true)
  })

  it("is inert and recognizable as a declaration", () => {
    const declaration = Config.Workspace()
    expect(Config.isWorkspace(declaration)).toBe(true)
    expect(Object.isFrozen(declaration)).toBe(true)
    expect(Config.isWorkspace({ cacheDirectory: ".flows" })).toBe(false)
    expect(Config.isWorkspace({ [Config.TypeId]: Config.TypeId, cacheDirectory: ".flows" })).toBe(false)
    expect(Config.isWorkspace(undefined)).toBe(false)
  })

  it("rejects accessors and proxies without invoking their traps", () => {
    let invoked = false
    const accessor = Object.defineProperty({}, Config.TypeId, {
      get: () => {
        invoked = true
        return Config.TypeId
      }
    })
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      }
    })
    expect(Config.isWorkspace(accessor)).toBe(false)
    expect(Config.isWorkspace(proxy)).toBe(false)
    expect(invoked).toBe(false)
  })

  it("validates the complete option bag without invoking accessors", () => {
    let invoked = false
    const accessor = Object.defineProperty({}, "cacheDirectory", {
      enumerable: true,
      get: () => {
        invoked = true
        return ".flows"
      }
    })
    expect(() => Config.Workspace(accessor)).toThrow(/data property/)
    expect(() => Config.Workspace({ typo: true } as never)).toThrow(/unknown option/)
    expect(() => Config.Workspace({ gitignored: "yes" } as never)).toThrow(/must be a boolean/)
    expect(invoked).toBe(false)
  })
})

describe("Config.normalizeDeclaredCacheDirectory", () => {
  it("rejects a non-string cache directory as a caller type error", () => {
    expect(() => Config.normalizeDeclaredCacheDirectory(null as never)).toThrowError(
      new TypeError("cacheDirectory must be a string")
    )
  })

  it("normalizes redundant separators, dot segments, and whitespace", () => {
    expect(Config.normalizeDeclaredCacheDirectory("  .flows/  ")).toBe(".flows")
    expect(Config.normalizeDeclaredCacheDirectory("./.flows")).toBe(".flows")
    expect(Config.normalizeDeclaredCacheDirectory("build//cache/")).toBe("build/cache")
  })

  it("refuses an empty value", () => {
    expect(() => Config.normalizeDeclaredCacheDirectory("")).toThrow(/must not be empty/)
    expect(() => Config.normalizeDeclaredCacheDirectory("   ")).toThrow(/must not be empty/)
    expect(() => Config.normalizeDeclaredCacheDirectory("./")).toThrow(/must not be empty/)
  })

  it("refuses an absolute path", () => {
    expect(() => Config.normalizeDeclaredCacheDirectory("/tmp/flows")).toThrow(/workspace-relative/)
    expect(() => Config.normalizeDeclaredCacheDirectory("C:\\flows")).toThrow(/workspace-relative/)
    expect(() => Config.normalizeDeclaredCacheDirectory("\\\\server\\flows")).toThrow(/workspace-relative/)
  })

  it("refuses parent traversal anywhere in the path", () => {
    expect(() => Config.normalizeDeclaredCacheDirectory("../flows")).toThrow(/must not leave the workspace/)
    expect(() => Config.normalizeDeclaredCacheDirectory("build/../../flows")).toThrow(/must not leave the workspace/)
  })

  it("refuses control characters, ill-formed text, and oversized paths", () => {
    expect(() => Config.normalizeDeclaredCacheDirectory("cache\nelsewhere")).toThrow(/control characters/)
    expect(() => Config.normalizeDeclaredCacheDirectory("cache\0elsewhere")).toThrow(/control characters/)
    expect(() => Config.normalizeDeclaredCacheDirectory("cache\ud800")).toThrow(/well-formed text/)
    expect(() => Config.normalizeDeclaredCacheDirectory("x".repeat(Config.maximumCacheDirectoryBytes + 1)))
      .toThrow(/at most/)
    expect(() =>
      Config.normalizeDeclaredCacheDirectory(
        `root/${"x".repeat(Config.maximumCacheDirectorySegmentBytes + 1)}`
      )
    ).toThrow(/segments must be at most/)
  })

  it("refuses the same values through Workspace", () => {
    expect(() => Config.Workspace({ cacheDirectory: "" })).toThrow(/must not be empty/)
    expect(() => Config.Workspace({ cacheDirectory: "/abs" })).toThrow(/workspace-relative/)
    expect(() => Config.Workspace({ cacheDirectory: ".." })).toThrow(/must not leave the workspace/)
  })
})

describe("Config.normalizeCacheDirectory", () => {
  it("accepts the declared form unchanged", () => {
    expect(Config.normalizeCacheDirectory("  ./.flows//cache/ ")).toBe(".flows/cache")
    expect(() => Config.normalizeCacheDirectory("/tmp/flows")).toThrow(/workspace-relative/)
  })

  it("accepts an outside directory as a leading run of .. segments", () => {
    expect(Config.normalizeCacheDirectory("../../tmp//state/")).toBe("../../tmp/state")
    expect(Config.isOutsideCacheDirectory("../../tmp/state")).toBe(true)
    expect(Config.isOutsideCacheDirectory(".flows")).toBe(false)
    expect(Config.isOutsideCacheDirectory("..flows")).toBe(false)
  })

  it("refuses .. after the leading run and a run with nothing after it", () => {
    expect(() => Config.normalizeCacheDirectory("../tmp/../state")).toThrow(
      "cacheDirectory must not leave the workspace: ../tmp/../state"
    )
    expect(() => Config.normalizeCacheDirectory("build/../../flows")).toThrow(/must not leave the workspace/)
    expect(() => Config.normalizeCacheDirectory("../..")).toThrow(/must not leave the workspace/)
  })

  it("refuses an outside directory on another Windows drive", () => {
    expect(() => Config.normalizeCacheDirectory("../../D:/state")).toThrow(
      "cacheDirectory outside the workspace must be on the workspace's drive: ../../D:/state"
    )
  })
})

describe("Workspace sandbox options", () => {
  it("defaults to no confinement and keeps a declared policy", () => {
    expect(Config.Workspace().sandbox).toBe("none")
    expect(Config.Workspace().sandboxes).toBeUndefined()
    expect(Config.Workspace({ sandbox: {} }).sandbox).toEqual({})
    expect(Config.Workspace({ sandbox: { network: "loopback" } }).sandbox).toEqual({ network: "loopback" })
    expect(Config.Workspace({ sandbox: "none" }).sandbox).toBe("none")
  })

  it("keeps a declared mechanism and refuses anything else", () => {
    const sandboxes = WorkspaceDeclaration.Sandboxes({
      default: WorkspaceDeclaration.Sandbox.Docker({ image: "node:22" })
    })
    expect(Config.Workspace({ sandboxes }).sandboxes).toBe(sandboxes)
    expect(() => Config.Workspace({ sandboxes: null as never })).toThrow(/S\.Sandboxes/)
    expect(() => Config.Workspace({ sandboxes: { default: "docker" } as never })).toThrow(/S\.Sandboxes/)
    expect(() => Config.Workspace({ sandbox: "always" as never })).toThrow(/sandbox/)
    expect(() => Config.Workspace({ sandbox: { network: "all" } as never })).toThrow(/sandbox/)
    expect(() => Config.Workspace({ sandbox: { reads: [] } as never })).toThrow(/sandbox/)
  })

  it("recognizes a declaration with and without the sandbox fields", () => {
    expect(Config.isWorkspace(Config.Workspace({ sandbox: {} }))).toBe(true)
    const legacy = { [Config.TypeId]: Config.TypeId, cacheDirectory: ".flows", gitignored: false }
    expect(Config.isWorkspace(legacy)).toBe(true)
    const forged = { [Config.TypeId]: Config.TypeId, cacheDirectory: ".flows", gitignored: false, sandbox: "always" }
    expect(Config.isWorkspace(forged)).toBe(false)
  })
})
