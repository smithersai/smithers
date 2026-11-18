/**
 * Where a command keeps its cache directory: the user cache directory on each
 * platform, the machine-placed directory, and the host a command reads.
 */
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as CacheLocation from "../src/internal/CacheLocation.ts"

const temporaries: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaries.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const host = (
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>> = {}
): CacheLocation.Host => ({ platform, environment, home: "/home/person" })

describe("userCacheDirectory", () => {
  it("prefers an absolute XDG_CACHE_HOME on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(CacheLocation.userCacheDirectory(host(platform, { XDG_CACHE_HOME: "/xdg" }))).toBe("/xdg")
    }
  })

  it("ignores a relative XDG_CACHE_HOME", () => {
    expect(CacheLocation.userCacheDirectory(host("linux", { XDG_CACHE_HOME: "relative" })))
      .toBe("/home/person/.cache")
  })

  it("uses ~/Library/Caches on macOS", () => {
    expect(CacheLocation.userCacheDirectory(host("darwin"))).toBe("/home/person/Library/Caches")
  })

  it("uses an absolute LOCALAPPDATA on Windows, else ~/.cache", () => {
    expect(CacheLocation.userCacheDirectory(host("win32", { LOCALAPPDATA: "/local" }))).toBe("/local")
    expect(CacheLocation.userCacheDirectory(host("win32", { LOCALAPPDATA: "relative" })))
      .toBe("/home/person/.cache")
    expect(CacheLocation.userCacheDirectory(host("win32"))).toBe("/home/person/.cache")
  })

  it("ignores LOCALAPPDATA off Windows", () => {
    expect(CacheLocation.userCacheDirectory(host("linux", { LOCALAPPDATA: "/local" }))).toBe("/home/person/.cache")
  })
})

describe("machineDirectory", () => {
  const hash = createHash("sha256").update("/work/repo").digest("hex").slice(0, 12)

  it("names the workspace and the first 12 hex digits of its root's sha256", () => {
    expect(CacheLocation.machineDirectory("/work/repo", "demo", ".flows/state", host("linux")))
      .toBe(`/home/person/.cache/smithers/demo-${hash}/.flows/state`)
  })

  it("makes the workspace name path-safe", () => {
    expect(CacheLocation.machineDirectory("/work/repo", "../a b/c-", ".flows", host("linux")))
      .toBe(`/home/person/.cache/smithers/a-b-c-${hash}/.flows`)
    expect(CacheLocation.machineDirectory("/work/repo", "///", ".flows", host("linux")))
      .toBe(`/home/person/.cache/smithers/workspace-${hash}/.flows`)
  })
})

describe("ambientHost", () => {
  it("reads an absolute HOME from the environment, else the account's home", () => {
    expect(CacheLocation.ambientHost({ HOME: "/elsewhere" }).home).toBe("/elsewhere")
    expect(CacheLocation.ambientHost({ HOME: "relative" }).home).toBe(Os.homedir())
    expect(CacheLocation.ambientHost({}).home).toBe(Os.homedir())
    expect(CacheLocation.ambientHost({}).platform).toBe(process.platform)
  })
})

describe("resolve", () => {
  const workspace = async (): Promise<{ readonly parent: string; readonly root: string }> => {
    const parent = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-cache-location-")))
    temporaries.push(parent)
    const root = NodePath.join(parent, "repo")
    await Fs.mkdir(root)
    return { parent, root }
  }

  it("keeps the declared directory when no flag names one", async () => {
    const { root } = await workspace()
    expect(CacheLocation.resolve(root, undefined, { directory: ".flows" }, "demo", host("linux"))).toBe(".flows")
  })

  it("validates a workspace-relative flag like a declaration", async () => {
    const { root } = await workspace()
    expect(CacheLocation.resolve(root, " ./state/ ", { directory: ".flows" }, "demo", host("linux"))).toBe("state")
    expect(() => CacheLocation.resolve(root, "a/../../b", { directory: ".flows" }, "demo", host("linux")))
      .toThrow("cacheDirectory must not leave the workspace: a/../../b")
    expect(() => CacheLocation.resolve(root, "", { directory: ".flows" }, "demo", host("linux")))
      .toThrow("cacheDirectory must not be empty")
  })

  it("carries an outside directory so every root reaches it", async () => {
    const { parent, root } = await workspace()
    const resolved = CacheLocation.resolve(root, "../state", { directory: ".flows" }, "demo", host("linux"))
    const climb = resolved.split("/").filter((segment) => segment === "..").length
    expect(climb).toBeGreaterThanOrEqual(CacheLocation.minimumClimb)
    for (const base of [root, parent, NodePath.join(Os.tmpdir(), "a", "b", "c")]) {
      expect(CacheLocation.absolute(base, resolved)).toBe(NodePath.join(parent, "state"))
    }
  })

  it("refuses the workspace itself", async () => {
    const { root } = await workspace()
    expect(() => CacheLocation.resolve(root, root, { directory: ".flows" }, "demo", host("linux")))
      .toThrow("cacheDirectory must not be empty")
  })
})
