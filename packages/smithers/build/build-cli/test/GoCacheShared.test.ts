import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as CacheAdmin from "../src/CacheAdmin.ts"
import * as GoCache from "../src/internal/GoCache.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const temporary = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-shared-")))
  roots.push(root)
  return root
}

const hour = 60 * 60 * 1000
const now = Date.parse("2026-11-10T12:00:00Z")
const host: GoCache.LeaseHost = { now, host: "build-host", alive: () => true }

/** Writes one compile cache output into the cache directory `cache`, last used `age` milliseconds before `now`. */
const compiled = async (cache: string, name: string, bytes: number, age: number): Promise<string> => {
  const shard = name.repeat(2)
  const relative = `${shard}/${shard}${name.repeat(62)}-d`
  await write(cache, relative, "x".repeat(bytes))
  const used = new Date(now - age)
  await Fs.utimes(NodePath.join(cache, relative), used, used)
  return NodePath.join(cache, relative)
}

const present = async (path: string): Promise<boolean> => Fs.stat(path).then(() => true, () => false)

describe("a compile cache the host shares between workspaces", () => {
  it("is the directory SMITHERS_GO_CACHE names, and the workspace's own without it", async () => {
    const local = NodePath.join("/work", ".flows", "go-build")
    expect(GoCache.directory("/work", ".flows", {})).toBe(local)
    expect(GoCache.directory("/work", ".flows", { SMITHERS_GO_CACHE: "" })).toBe(local)
    expect(GoCache.directory("/work", ".flows", { SMITHERS_GO_CACHE: "/var/cache/go/../go-shared/" })).toBe(
      "/var/cache/go-shared"
    )
    expect(GoCache.spawnEnvironment({ A: "1" }, "/work", ".flows", { SMITHERS_GO_CACHE: "/var/cache/go" })).toEqual({
      A: "1",
      GOCACHE: "/var/cache/go"
    })
    expect(() => GoCache.directory("/work", ".flows", { SMITHERS_GO_CACHE: "relative/cache" })).toThrow(
      "SMITHERS_GO_CACHE must be an absolute directory: relative/cache"
    )
  })

  it("measures, leases and evicts in the shared directory and leaves the workspace's own alone", async () => {
    const root = await temporary()
    const shared = NodePath.join(await temporary(), "go")
    const environment = { SMITHERS_GO_CACHE: shared }
    expect(await GoCache.status(root, ".flows", environment)).toEqual({
      directory: shared,
      exists: false,
      entries: 0,
      bytes: 0
    })
    expect(await GoCache.leased("Shell.Test", root, ".flows", environment)).toBe(false)
    const idle = await compiled(shared, "a", 300, 5 * hour)
    const read = await compiled(shared, "b", 200, 2 * hour + hour / 2)
    const own = await compiled(NodePath.join(root, ".flows/go-build"), "c", 100, 5 * hour)
    expect(await GoCache.status(root, ".flows", environment)).toMatchObject({ exists: true, entries: 2, bytes: 500 })
    expect(await GoCache.leased("Shell.Test", root, ".flows", environment)).toBe(true)
    const lease = await GoCache.acquireLease(root, ".flows", { ...host, now: now - 2 * hour }, environment)
    expect(NodePath.dirname(lease)).toBe(NodePath.join(shared, "smthrs-leases"))
    expect(await GoCache.usage(root, ".flows", host, environment)).toEqual({ floor: now - 3 * hour, stale: [] })
    const pruned = await CacheAdmin.remove({
      root,
      cacheDirectory: ".flows",
      olderThanDays: 30,
      maxSizeBytes: 0,
      dryRun: false,
      yes: true,
      now,
      leaseHost: host,
      environment
    })
    expect(pruned).toMatchObject({
      goBuild: { candidates: 1, removed: 1, bytes: 300, inUse: 1, inUseBytes: 200 },
      size: { before: 500, after: 200 }
    })
    expect(await Promise.all([idle, read, own].map(present))).toEqual([false, true, true])
  })

  it("refuses a shared directory that is a link", async () => {
    const root = await temporary()
    const elsewhere = await temporary()
    const link = NodePath.join(await temporary(), "go")
    await compiled(elsewhere, "a", 100, 5 * hour)
    await Fs.symlink(elsewhere, link)
    await expect(GoCache.entries(root, ".flows", { SMITHERS_GO_CACHE: link })).rejects.toThrow("not a plain directory")
  })
})

const workspace = async (root: string, targets: string): Promise<void> => {
  await write(root, "package.json", "{\"name\":\"fixture\",\"private\":true}\n")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("fixture", { repository: "git+https://example.test/fixture.git", cache: S.Cache({ directory: ".flows" }) })
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { ${targets} } })
`
  )
  NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
}

const canConfine = process.platform === "darwin" ||
  (process.platform === "linux" && NodeChildProcess.spawnSync("sh", ["-c", "command -v bwrap"]).status === 0)

describe("unconfined tools on a host with a shared compile cache", () => {
  it("spawn with it, hold their lease in it, and cache status and prune act on it", async () => {
    const root = await temporary()
    const shared = NodePath.join(await temporary(), "go")
    await workspace(
      root,
      `shared: S.Shell.Test({ shell: ${
        JSON.stringify(`test "$GOCACHE" = '${shared}' && ls "$GOCACHE/smthrs-leases" | grep -q json`)
      }, sandbox: "none" }),
  control: S.Shell.Test({ shell: ${
        JSON.stringify(`test "$GOCACHE" = '${GoCache.directory(root, ".flows")}'`)
      }, sandbox: "none" })`
    )
    const stale = await compiled(shared, "a", 2048, 0)
    const old = new Date(Date.now() - 3 * 24 * hour)
    await Fs.utimes(stale, old, old)
    const environment = { ...process.env, SMITHERS_GO_CACHE: shared }
    const ran = await serve(root, ["//:shared"], { environment })
    expect(ran.exitCode, ran.logs + ran.output).toBe(0)
    expect((await serve(root, ["//:control"], { environment })).exitCode).toBe(1)
    expect(await Fs.readdir(NodePath.join(shared, "smthrs-leases"))).toEqual([])
    await expect(Fs.stat(NodePath.join(root, ".flows/go-build"))).rejects.toMatchObject({ code: "ENOENT" })
    const status = await serve(root, ["cache", "status", "--format", "json"], { environment })
    expect(JSON.parse(status.output).goBuild).toEqual({ directory: shared, exists: true, entries: 1, bytes: 2048 })
    const pruned = await serve(root, ["cache", "prune", "--max-size", "1KiB", "--yes", "--format", "json"], {
      environment
    })
    const report = JSON.parse(pruned.output)
    expect(report).toMatchObject({ goBuild: { removed: 1, bytes: 2048 }, size: { limit: 1024 } })
    // What is left is the action result the run above stored.
    expect(report.size.after).toBe(report.size.before - 2048)
    expect(await present(stale)).toBe(false)
  }, 120_000)

  it("refuses a relative shared directory instead of guessing where it is", async () => {
    const root = await temporary()
    await workspace(root, `plain: S.Shell.Test({ shell: "true", sandbox: "none" })`)
    const environment = { ...process.env, SMITHERS_GO_CACHE: "relative/cache" }
    const status = await serve(root, ["cache", "status", "--format", "json"], { environment })
    expect(status.exitCode).toBe(1)
    expect(status.output).toContain("SMITHERS_GO_CACHE must be an absolute directory")
    const ran = await serve(root, ["//:plain"], { environment })
    expect(ran.exitCode).toBe(1)
    expect(ran.logs + ran.output).toContain("SMITHERS_GO_CACHE must be an absolute directory")
  }, 120_000)

  // A confined tool can write only inside its workspace, and a cache one
  // checkout's sandboxed target could write would be a cache every other
  // checkout trusts.
  it.runIf(canConfine)("does not reach a confined tool, which keeps the workspace's own cache", async () => {
    const root = await temporary()
    const shared = NodePath.join(await temporary(), "go")
    await workspace(
      root,
      `confined: S.Shell.Test({ shell: ${
        JSON.stringify(`test "$GOCACHE" = '${GoCache.directory(root, ".flows")}' && mkdir -p "$GOCACHE/00"`)
      }, sandbox: {} })`
    )
    const ran = await serve(root, ["//:confined"], { environment: { ...process.env, SMITHERS_GO_CACHE: shared } })
    expect(ran.exitCode, ran.logs + ran.output).toBe(0)
    expect(await present(NodePath.join(root, ".flows/go-build/00"))).toBe(true)
    expect(await present(shared)).toBe(false)
  }, 120_000)
})

const hasGo = PackageTree.findOnPath("go") !== undefined

describe.runIf(hasGo)("two checkouts on one host", () => {
  const checkout = async (): Promise<string> => {
    const root = await temporary()
    await write(root, "go.mod", "module example.test/shared\n\ngo 1.24\n")
    await write(root, "go.sum", "")
    await write(root, "flake.nix", "{}\n")
    await write(root, "flake.lock", "{}\n")
    await write(root, "cmd/app/main.go", "package main\nimport \"fmt\"\nfunc main() { fmt.Println(\"ok\") }\n")
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const nix = S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
const go = S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: nix, cgo: false })
export const Workspace = S.Workspace("shared", { repository: "git+https://example.test/shared.git", cache: S.Cache({ directory: ".flows" }), toolchains: [nix, go] })
`
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { binary: S.Go.Binary({ pkg: "./cmd/app", out: "//build/app", sandbox: "none" }) } })
`
    )
    NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
    return root
  }

  it("compile into one cache that either checkout measures", async () => {
    const first = await checkout()
    const second = await checkout()
    const shared = NodePath.join(await temporary(), "go")
    const environment = { ...process.env, SMITHERS_GO_CACHE: shared }
    const built = await serve(first, ["//:binary"], { environment })
    expect(built.exitCode, built.logs + built.output).toBe(0)
    const filled = await GoCache.entries(first, ".flows", environment)
    expect(filled.length).toBeGreaterThan(0)
    expect(await GoCache.entries(first, ".flows")).toEqual([])
    // The second checkout sees what the first compiled before it builds anything.
    const status = await serve(second, ["cache", "status", "--format", "json"], { environment })
    expect(JSON.parse(status.output).goBuild).toMatchObject({ directory: shared, entries: filled.length })
    const rebuilt = await serve(second, ["//:binary"], { environment })
    expect(rebuilt.exitCode, rebuilt.logs + rebuilt.output).toBe(0)
    expect(await GoCache.entries(second, ".flows")).toEqual([])
    await expect(Fs.stat(NodePath.join(second, ".flows/go-build"))).rejects.toMatchObject({ code: "ENOENT" })
  }, 240_000)
})
