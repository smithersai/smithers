import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
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
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-prune-")))
  roots.push(root)
  return root
}

const hour = 60 * 60 * 1000
const day = 24 * hour
const now = Date.parse("2026-11-10T12:00:00Z")
const host: GoCache.LeaseHost = { now, host: "build-host", alive: () => true }

/** Writes one compile cache output of `bytes` bytes that `go` last used `age` milliseconds before `now`. */
const compiled = async (root: string, name: string, bytes: number, age: number): Promise<string> => {
  const shard = name.repeat(2)
  const relative = `.flows/go-build/${shard}/${shard}${name.repeat(62)}-d`
  await write(root, relative, "x".repeat(bytes))
  const used = new Date(now - age)
  await Fs.utimes(NodePath.join(root, relative), used, used)
  return NodePath.join(root, relative)
}

const present = async (path: string): Promise<boolean> => Fs.stat(path).then(() => true, () => false)

const leaseFile = async (root: string, name: string, record: unknown): Promise<string> => {
  const relative = `.flows/go-build/smthrs-leases/${name}.json`
  await write(root, relative, typeof record === "string" ? record : JSON.stringify(record))
  return NodePath.join(root, relative)
}

const prune = (root: string, maxSizeBytes: number, overrides: Partial<Parameters<typeof CacheAdmin.remove>[0]> = {}) =>
  CacheAdmin.remove({
    root,
    cacheDirectory: ".flows",
    olderThanDays: 30,
    maxSizeBytes,
    dryRun: false,
    yes: true,
    now,
    leaseHost: host,
    ...overrides
  })

describe("cache size text", () => {
  it("reads binary and decimal units, and bare bytes", () => {
    expect(CacheAdmin.parseSize("40GiB")).toBe(40 * 1024 ** 3)
    expect(CacheAdmin.parseSize("500MB")).toBe(500_000_000)
    expect(CacheAdmin.parseSize(" 1.5 kib ")).toBe(1536)
    expect(CacheAdmin.parseSize("2TiB")).toBe(2 * 1024 ** 4)
    expect(CacheAdmin.parseSize("3tb")).toBe(3e12)
    expect(CacheAdmin.parseSize("7kB")).toBe(7000)
    expect(CacheAdmin.parseSize("9B")).toBe(9)
    expect(CacheAdmin.parseSize("1024")).toBe(1024)
    expect(CacheAdmin.parseSize("0")).toBe(0)
  })

  it.each(["forty", "5XB", "-1GB", "", "1e3", "GiB"])("refuses %j", (text) => {
    expect(() => CacheAdmin.parseSize(text)).toThrow("cache size must be a number")
  })
})

describe("cache prune under a size cap", () => {
  it("evicts the least recently used compile results until the cache fits", async () => {
    const root = await temporary()
    const oldest = await compiled(root, "a", 400, 9 * day)
    const older = await compiled(root, "b", 300, 5 * day)
    const recent = await compiled(root, "c", 200, 2 * day)
    const newest = await compiled(root, "d", 100, 3 * hour)
    const preview = await prune(root, 350, { dryRun: true, yes: false })
    expect(preview).toMatchObject({
      dryRun: true,
      goBuild: { candidates: 2, candidateBytes: 700, removed: 0, bytes: 0, inUse: 0, inUseBytes: 0 },
      size: { limit: 350, before: 1000, after: 300 }
    })
    expect(await Promise.all([oldest, older, recent, newest].map(present))).toEqual([true, true, true, true])
    const pruned = await prune(root, 350)
    expect(pruned).toMatchObject({
      dryRun: false,
      candidates: 0,
      removed: 0,
      goBuild: { candidates: 2, candidateBytes: 700, removed: 2, bytes: 700, inUse: 0, inUseBytes: 0 },
      size: { limit: 350, before: 1000, after: 300 }
    })
    expect(await Promise.all([oldest, older, recent, newest].map(present))).toEqual([false, false, true, true])
    // Already under the cap: nothing is a candidate.
    expect(await prune(root, 350)).toMatchObject({ goBuild: { candidates: 0, removed: 0 }, size: { after: 300 } })
  })

  it("counts action results in the cap and evicts them by age alongside compile results", async () => {
    const root = await temporary()
    const cache = await Cache.openCache({ workspaceRoot: root, cacheDirectory: ".flows" })
    for (const key of ["aaaaaa", "bbbbbb"]) {
      await cache.put(key, {
        key,
        label: "//:t",
        target: "Filegroup",
        exitOk: true,
        output: {},
        storedAt: new Date(now).toISOString()
      })
    }
    await cache.close()
    const [stale, fresh] = await CacheAdmin.entries(root, ".flows")
    await Fs.utimes(stale!.path, new Date(now - 40 * day), new Date(now - 40 * day))
    await Fs.utimes(fresh!.path, new Date(now - 4 * day), new Date(now - 4 * day))
    const object = await compiled(root, "a", 500, 2 * day)
    const kept = await compiled(root, "b", 50, 2 * hour)
    const results = stale!.bytes + fresh!.bytes
    // The retention window takes the 40 day old result; the cap then takes
    // the next least recently used entries, a result and a compile result.
    const pruned = await prune(root, 60)
    expect(pruned).toMatchObject({
      candidates: 2,
      removed: 2,
      bytes: results,
      goBuild: { candidates: 1, removed: 1, bytes: 500 },
      size: { limit: 60, before: results + 550, after: 50 }
    })
    expect(await CacheAdmin.entries(root, ".flows")).toEqual([])
    expect(await Promise.all([object, kept].map(present))).toEqual([false, true])
  })

  it("leaves the compile cache alone without a size cap", async () => {
    const root = await temporary()
    const object = await compiled(root, "a", 500, 400 * day)
    const pruned = await CacheAdmin.remove({
      root,
      cacheDirectory: ".flows",
      olderThanDays: 1,
      dryRun: false,
      yes: true
    })
    expect(pruned).not.toHaveProperty("goBuild")
    expect(pruned).not.toHaveProperty("size")
    expect(await present(object)).toBe(true)
  })

  it("never evicts what a running tool may be reading", async () => {
    const root = await temporary()
    // A run that began twelve hours ago is still going. go refreshes a use
    // time at most hourly, so anything used from an hour before it began may
    // be an entry it read.
    const lease = await GoCache.acquireLease(root, ".flows", { ...host, now: now - 12 * hour })
    const untouched = await compiled(root, "a", 100, 14 * hour)
    const readByRun = await compiled(root, "b", 100, 12 * hour + hour / 2)
    const writtenByRun = await compiled(root, "c", 100, 6 * hour)
    const pruned = await prune(root, 0)
    expect(pruned).toMatchObject({
      goBuild: { candidates: 1, removed: 1, bytes: 100, inUse: 2, inUseBytes: 200 },
      size: { limit: 0, before: 300, after: 200 }
    })
    expect(await Promise.all([untouched, readByRun, writtenByRun].map(present))).toEqual([false, true, true])
    expect(await present(lease)).toBe(true)
    // The run ends; what it read is ordinary cache again.
    await GoCache.releaseLease(lease)
    await GoCache.releaseLease(lease)
    expect(await prune(root, 0)).toMatchObject({ goBuild: { removed: 2, inUse: 0 }, size: { after: 0 } })
  })

  it("keeps the last hour's entries when no run holds a lease", async () => {
    const root = await temporary()
    const planned = await compiled(root, "a", 100, hour / 2)
    const idle = await compiled(root, "b", 100, 2 * hour)
    expect(await prune(root, 0)).toMatchObject({ goBuild: { removed: 1, inUse: 1, inUseBytes: 100 } })
    expect(await Promise.all([planned, idle].map(present))).toEqual([true, false])
  })

  it("keeps a longer idle window for a go that holds no lease, and never a shorter one than go's hour", async () => {
    const root = await temporary()
    const recent = await compiled(root, "a", 100, 2 * hour)
    const idle = await compiled(root, "b", 100, 4 * hour)
    expect(await GoCache.usage(root, ".flows", host, {}, 3 * hour)).toEqual({ floor: now - 3 * hour, stale: [] })
    expect(await GoCache.usage(root, ".flows", host, {}, 60_000)).toEqual({ floor: now - hour, stale: [] })
    // A lease that began before the idle window still reaches further back.
    const lease = await GoCache.acquireLease(root, ".flows", { ...host, now: now - 5 * hour })
    expect(await GoCache.usage(root, ".flows", host, {}, 3 * hour)).toEqual({ floor: now - 6 * hour, stale: [] })
    await GoCache.releaseLease(lease)
    expect(await prune(root, 0, { keepUsedWithinMs: 3 * hour })).toMatchObject({
      goBuild: { removed: 1, inUse: 1, inUseBytes: 100 }
    })
    expect(await Promise.all([recent, idle].map(present))).toEqual([true, false])
    expect(await prune(root, 0)).toMatchObject({ goBuild: { removed: 1, inUse: 0 } })
    expect(await present(recent)).toBe(false)
  })

  it("does not believe a lease whose owner is gone, and removes it", async () => {
    const root = await temporary()
    const exited = NodeChildProcess.spawnSync(process.execPath, ["-e", ""])
    expect(exited.status).toBe(0)
    const real = GoCache.leaseHost(now)
    const dead = await leaseFile(root, "dead", { pid: exited.pid, host: real.host, startedAt: now - 3 * day })
    const expired = await leaseFile(root, "expired", { pid: process.pid, host: real.host, startedAt: now - 2 * day })
    const corrupt = await leaseFile(root, "corrupt", "{")
    const shapeless = await leaseFile(root, "shapeless", "null")
    const partial = await leaseFile(root, "partial", { pid: 1, host: real.host })
    const object = await compiled(root, "a", 100, 2 * day)
    const preview = await prune(root, 0, { leaseHost: real, dryRun: true })
    expect(preview).toMatchObject({ goBuild: { candidates: 1, inUse: 0 } })
    expect(await Promise.all([dead, expired, corrupt, shapeless, partial].map(present))).toEqual([
      true,
      true,
      true,
      true,
      true
    ])
    expect(await prune(root, 0, { leaseHost: real })).toMatchObject({ goBuild: { removed: 1, inUse: 0 } })
    expect(await present(object)).toBe(false)
    expect(await Promise.all([dead, expired, corrupt, shapeless, partial].map(present))).toEqual([
      false,
      false,
      false,
      false,
      false
    ])
  })

  it("believes this process's own lease and another machine's until it expires", async () => {
    const root = await temporary()
    const real = GoCache.leaseHost(now)
    expect(real.alive(process.pid)).toBe(true)
    // A process this user may not signal, such as init, is still running.
    if (process.getuid?.() !== 0) expect(real.alive(1)).toBe(true)
    const own = await leaseFile(root, "own", { pid: process.pid, host: real.host, startedAt: now - 12 * hour })
    const object = await compiled(root, "a", 100, 11 * hour)
    expect(await prune(root, 0, { leaseHost: real })).toMatchObject({ goBuild: { removed: 0, inUse: 1 } })
    await Fs.rm(own)
    // Another machine's process cannot be probed from here.
    const foreign = await leaseFile(root, "foreign", {
      pid: 2 ** 22 + 1,
      host: "another-host",
      startedAt: now - 12 * hour
    })
    expect(await prune(root, 0, { leaseHost: real })).toMatchObject({ goBuild: { removed: 0, inUse: 1 } })
    expect(await present(foreign)).toBe(true)
    const later = { ...real, now: now + day }
    expect(await prune(root, 0, { leaseHost: later, now: later.now })).toMatchObject({ goBuild: { removed: 1 } })
    expect(await Promise.all([foreign, object].map(present))).toEqual([false, false])
  })

  it("leaves an entry go used or replaced after it was listed", async () => {
    const root = await temporary()
    const used = await compiled(root, "a", 100, 2 * day)
    const replaced = await compiled(root, "b", 100, 2 * day)
    const gone = await compiled(root, "c", 100, 2 * day)
    const idle = await compiled(root, "d", 100, 2 * day)
    const listed = await GoCache.entries(root, ".flows")
    // A run that started after the listing reads one entry, rewrites one and
    // go's own trim removes one.
    await Fs.utimes(used, new Date(now), new Date(now))
    await Fs.rm(replaced)
    await compiled(root, "b", 100, 0)
    await Fs.rm(gone)
    expect(await GoCache.evict(root, ".flows", listed)).toEqual({ removed: 1, bytes: 100 })
    expect(await Promise.all([used, replaced, gone, idle].map(present))).toEqual([true, true, false, false])
  })

  it("stops when the cache directory is not the one that was listed", async () => {
    const root = await temporary()
    const other = await temporary()
    await compiled(root, "a", 100, 2 * day)
    const object = await compiled(other, "a", 100, 2 * day)
    const foreign = await GoCache.entries(other, ".flows")
    await expect(GoCache.evict(root, ".flows", foreign)).rejects.toThrow("changed during eviction")
    await Fs.rm(NodePath.join(root, ".flows"), { recursive: true })
    await expect(GoCache.evict(root, ".flows", foreign)).rejects.toThrow("changed during eviction")
    expect(await present(object)).toBe(true)
  })

  it("reports no floor trouble for a workspace that has no compile cache", async () => {
    const root = await temporary()
    expect(await GoCache.usage(root, ".flows", host)).toEqual({ floor: now - hour, stale: [] })
    expect(await prune(root, 0)).toMatchObject({
      goBuild: { candidates: 0, removed: 0, inUse: 0 },
      size: { before: 0, after: 0 }
    })
    await expect(Fs.stat(NodePath.join(root, ".flows"))).rejects.toMatchObject({ code: "ENOENT" })
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

describe("a running tool's lease", () => {
  it("is taken by a Go rule always and by any other tool once the workspace compiles Go", async () => {
    const root = await temporary()
    expect(await GoCache.leased("Go.Test", root, ".flows")).toBe(true)
    expect(await GoCache.leased("Shell.Test", root, ".flows")).toBe(false)
    await write(root, ".flows/go-build", "a file is not a compile cache")
    expect(await GoCache.leased("Shell.Test", root, ".flows")).toBe(false)
    await Fs.rm(NodePath.join(root, ".flows/go-build"))
    await Fs.mkdir(NodePath.join(root, ".flows/go-build"))
    expect(await GoCache.leased("Shell.Test", root, ".flows")).toBe(true)
  })

  it("is held while the tool runs and released when it exits", async () => {
    const root = await temporary()
    await workspace(
      root,
      `held: S.Shell.Test({ shell: "ls \\"$GOCACHE/smthrs-leases\\" | grep -c json" }),
  failing: S.Shell.Test({ shell: "ls \\"$GOCACHE/smthrs-leases\\" | grep -q json && exit 3" })`
    )
    await Fs.mkdir(NodePath.join(root, ".flows/go-build"), { recursive: true })
    const held = await serve(root, ["//:held"])
    expect(held.exitCode, held.logs + held.output).toBe(0)
    expect(await Fs.readdir(NodePath.join(root, ".flows/go-build/smthrs-leases"))).toEqual([])
    // A failing tool releases its lease too.
    const failing = await serve(root, ["//:failing"])
    expect(failing.exitCode).toBe(1)
    expect(await Fs.readdir(NodePath.join(root, ".flows/go-build/smthrs-leases"))).toEqual([])
  }, 120_000)

  it("adds no compile cache directory to a workspace that never runs go", async () => {
    const root = await temporary()
    await workspace(root, `plain: S.Shell.Test({ shell: "test -n \\"$GOCACHE\\" && test ! -e \\"$GOCACHE\\"" })`)
    const plain = await serve(root, ["//:plain"])
    expect(plain.exitCode, plain.logs + plain.output).toBe(0)
    await expect(Fs.stat(NodePath.join(root, ".flows/go-build"))).rejects.toMatchObject({ code: "ENOENT" })
  }, 120_000)
})

describe("cache prune --max-size", () => {
  it("previews, evicts and refuses a size it cannot read", async () => {
    const root = await temporary()
    await workspace(root, `plain: S.Shell.Test({ shell: "true" })`)
    const old = new Date(Date.now() - 3 * day)
    const stale = NodePath.join(root, `.flows/go-build/aa/aa${"a".repeat(62)}-d`)
    const fresh = NodePath.join(root, `.flows/go-build/bb/bb${"b".repeat(62)}-a`)
    await write(root, NodePath.relative(root, stale), "x".repeat(2048))
    await write(root, NodePath.relative(root, fresh), "x".repeat(10))
    await Fs.utimes(stale, old, old)
    const preview = await serve(root, ["cache", "prune", "--max-size", "1KiB", "--dry-run", "--format", "json"])
    expect(preview.exitCode, preview.output).toBe(0)
    expect(JSON.parse(preview.output)).toMatchObject({
      dryRun: true,
      goBuild: { candidates: 1, candidateBytes: 2048, removed: 0 },
      size: { limit: 1024, before: 2058, after: 10 }
    })
    expect(await present(stale)).toBe(true)
    const pruned = await serve(root, ["cache", "prune", "--max-size", "1KiB", "--yes", "--format", "json"])
    expect(pruned.exitCode, pruned.output).toBe(0)
    expect(JSON.parse(pruned.output)).toMatchObject({
      goBuild: { removed: 1, bytes: 2048, inUse: 0 },
      size: { limit: 1024, before: 2058, after: 10 }
    })
    expect(await Promise.all([stale, fresh].map(present))).toEqual([false, true])
    // The entry written a moment ago is in use: a cap it exceeds leaves it.
    const capped = await serve(root, ["cache", "prune", "--max-size", "0", "--yes", "--format", "json"])
    expect(JSON.parse(capped.output)).toMatchObject({
      goBuild: { removed: 0, inUse: 1, inUseBytes: 10 },
      size: { after: 10 }
    })
    // Five hours of idle window keep the three day old entry's successor too.
    await write(root, NodePath.relative(root, stale), "x".repeat(2048))
    const fourHours = new Date(Date.now() - 4 * hour)
    await Fs.utimes(stale, fourHours, fourHours)
    const windowed = await serve(root, [
      "cache",
      "prune",
      "--max-size",
      "0",
      "--keep-used-minutes",
      "300",
      "--yes",
      "--format",
      "json"
    ])
    expect(JSON.parse(windowed.output)).toMatchObject({ goBuild: { removed: 0, inUse: 2, inUseBytes: 2058 } })
    expect(await present(stale)).toBe(true)
    const tooShort = await serve(root, ["cache", "prune", "--max-size", "0", "--keep-used-minutes", "5", "--yes"])
    expect(tooShort.exitCode).toBe(1)
    expect(await present(stale)).toBe(true)
    const refused = await serve(root, ["cache", "prune", "--max-size", "plenty", "--yes", "--format", "json"])
    expect(refused.exitCode).toBe(1)
    expect(refused.output).toContain("cache_prune_failed")
    expect(refused.output).toContain("cache size must be a number")
  }, 120_000)
})

const hasGo = PackageTree.findOnPath("go") !== undefined

describe.runIf(hasGo)("pruning a real Go compile cache", () => {
  it("empties an idle cache, and the next build compiles again into the same directory", async () => {
    const root = await temporary()
    await write(root, "go.mod", "module example.test/pruned\n\ngo 1.24\n")
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
export const Workspace = S.Workspace("pruned", { repository: "git+https://example.test/pruned.git", cache: S.Cache({ directory: ".flows" }), toolchains: [nix, go] })
`
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { binary: S.Go.Binary({ pkg: "./cmd/app", out: "//build/app" }) } })
`
    )
    NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
    const built = await serve(root, ["//:binary"])
    expect(built.exitCode, built.logs + built.output).toBe(0)
    const filled = await GoCache.entries(root, ".flows")
    expect(filled.length).toBeGreaterThan(0)
    // Everything was used a moment ago, so a cap of zero evicts nothing.
    const busy = JSON.parse(
      (await serve(root, ["cache", "prune", "--max-size", "0", "--yes", "--format", "json"])).output
    )
    expect(busy.goBuild).toMatchObject({ removed: 0, inUse: filled.length })
    // Two idle days later the same cap empties it.
    const idle = new Date(Date.now() - 2 * day)
    for (const entry of filled) await Fs.utimes(entry.path, idle, idle)
    const emptied = JSON.parse(
      (await serve(root, ["cache", "prune", "--max-size", "0", "--yes", "--format", "json"])).output
    )
    expect(emptied.goBuild).toMatchObject({ removed: filled.length, inUse: 0 })
    expect(await GoCache.entries(root, ".flows")).toEqual([])
    await write(root, "cmd/app/main.go", "package main\nimport \"fmt\"\nfunc main() { fmt.Println(\"again\") }\n")
    const rebuilt = await serve(root, ["//:binary"])
    expect(rebuilt.exitCode, rebuilt.logs + rebuilt.output).toBe(0)
    expect(NodeChildProcess.execFileSync(NodePath.join(root, "build/app"), { encoding: "utf8" })).toContain("again")
    expect((await GoCache.entries(root, ".flows")).length).toBeGreaterThan(0)
  }, 240_000)
})
