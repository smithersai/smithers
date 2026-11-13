/**
 * The local action-result cache under hostile or changing state: unreadable
 * directories, files that are not results, shards and files swapped while a
 * listing or a deletion is in progress, and records that are not results.
 * Every case uses the real filesystem; changes made "during" a deletion run
 * inside the injected lease host's liveness probe, which the prune consults
 * after it has listed its candidates and before it deletes them.
 *
 * @since 1.0.0
 */
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { entryLimit } from "../src/Cache.ts"
import * as CacheAdmin from "../src/CacheAdmin.ts"
import type * as GoCache from "../src/internal/GoCache.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const temporary = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-cache-admin-")))
  roots.push(root)
  return root
}

const hour = 60 * 60 * 1000
const now = Date.parse("2026-11-10T12:00:00Z")

/** Writes one stored result last modified an hour before `now`. */
const result = async (root: string, relative: string, text: string): Promise<string> => {
  await write(root, `.flows/cache/${relative}`, text)
  const path = NodePath.join(root, ".flows/cache", relative)
  await Fs.utimes(path, new Date(now - hour), new Date(now - hour))
  return path
}

const present = (path: string): Promise<boolean> => Fs.lstat(path).then(() => true, () => false)

/** A lease host whose liveness probe changes the cache once, mid-prune. */
const changingHost = async (root: string, change: () => void): Promise<GoCache.LeaseHost> => {
  await write(
    root,
    ".flows/go-build/smthrs-leases/live.json",
    JSON.stringify({ pid: process.pid, host: "fixture-host", startedAt: now - 1000 })
  )
  let changed = false
  return {
    now,
    host: "fixture-host",
    alive: () => {
      if (!changed) change()
      changed = true
      return true
    }
  }
}

const prune = (root: string, leaseHost: GoCache.LeaseHost) =>
  CacheAdmin.remove({
    root,
    cacheDirectory: ".flows",
    olderThanDays: 0,
    maxSizeBytes: 1024 ** 4,
    dryRun: false,
    yes: true,
    now,
    leaseHost,
    environment: {}
  })

describe("listing results", () => {
  it("reports an unreadable cache path instead of calling the cache absent", async () => {
    const root = await temporary()
    await result(root, "ab/ab01.json", "{}")
    await Fs.chmod(NodePath.join(root, ".flows"), 0o600)
    try {
      await expect(CacheAdmin.entries(root, ".flows")).rejects.toMatchObject({ code: "EACCES" })
    } finally {
      await Fs.chmod(NodePath.join(root, ".flows"), 0o700)
    }
  })

  it("lists only well-named result files inside well-named shards, in path order", async () => {
    const root = await temporary()
    const kept = [
      await result(root, "cd/cd01.json", "{}"),
      await result(root, "ab/ab02.json", "{}"),
      await result(root, "ab/ab01.json", "{\"x\":1}")
    ]
    await result(root, "stray.json", "{}")
    await result(root, "abc/abc01.json", "{}")
    await result(root, "ab/zz01.json", "{}")
    await result(root, "ab/ab-notes.txt", "notes")
    await result(root, "ab/.ab03.json", "{}")
    const listed = await CacheAdmin.entries(root, ".flows")
    expect(listed.map((entry) => entry.path)).toEqual([...kept].sort())
    expect(listed.find((entry) => entry.path.endsWith("ab01.json"))?.bytes).toBe(7)
  })

  it("skips files in a shard it may list but not search", async () => {
    const root = await temporary()
    const reachable = await result(root, "cd/cd01.json", "{}")
    await result(root, "ab/ab01.json", "{}")
    const shard = NodePath.join(root, ".flows/cache/ab")
    await Fs.chmod(shard, 0o400)
    try {
      expect((await CacheAdmin.entries(root, ".flows")).map((entry) => entry.path)).toEqual([reachable])
    } finally {
      await Fs.chmod(shard, 0o700)
    }
  })

  it("skips a shard replaced by a link after the cache was listed", async () => {
    const root = await temporary()
    const base = NodePath.join(root, ".flows/cache")
    for (const shard of ["aa", "bb"]) {
      for (let index = 0; index < 300; index += 1) await result(root, `${shard}/${shard}${index}.json`, "{}")
    }
    // The second shard in directory order is swapped only after `entries`
    // has read the cache directory, which the directory's access time shows.
    const order = await Fs.readdir(base)
    const later = order.indexOf("aa") < order.indexOf("bb") ? "bb" : "aa"
    const stat = await Fs.stat(base)
    await Fs.utimes(base, new Date(stat.mtimeMs - hour), stat.mtime)
    const before = (await Fs.stat(base)).atimeMs
    const listing = CacheAdmin.entries(root, ".flows")
    for (let poll = 0; poll < 100_000 && (await Fs.stat(base)).atimeMs === before; poll += 1) {
      // Wait for the listing to read the cache directory.
    }
    NodeFs.renameSync(NodePath.join(base, later), NodePath.join(base, `${later}-held`))
    NodeFs.symlinkSync(`${later}-held`, NodePath.join(base, later))
    const listed = await listing
    expect(listed).toHaveLength(300)
    expect(listed.every((entry) => NodePath.basename(NodePath.dirname(entry.path)) !== later)).toBe(true)
  })
})

describe("inspecting one result", () => {
  const stored = { key: "ab01", label: "//lib:srcs", target: "Filegroup", exitOk: true, storedAt: "2026-11-10" }

  it.each([
    ["no shard for the key", "elsewhere"],
    ["no file in the shard", undefined],
    ["a file larger than a stored result may be", "oversized"],
    ["text that is not JSON", "{"],
    ["JSON that is not an object", "null"],
    ["a record for another key", JSON.stringify({ ...stored, key: "ab02" })],
    ["a record missing its outcome", JSON.stringify({ ...stored, exitOk: "yes" })]
  ])("answers nothing for %s", async (_name, text) => {
    const root = await temporary()
    await result(root, "ab/ab09.json", "{}")
    if (text === "elsewhere") {
      await Fs.rm(NodePath.join(root, ".flows/cache/ab"), { recursive: true })
      await result(root, "cd/cd01.json", "{}")
    } else if (text === "oversized") {
      await result(root, "ab/ab01.json", "")
      await Fs.truncate(NodePath.join(root, ".flows/cache/ab/ab01.json"), entryLimit + 1)
    } else if (text !== undefined) {
      await result(root, "ab/ab01.json", text)
    }
    expect(await CacheAdmin.inspect(root, ".flows", "ab01")).toBeUndefined()
  })

  it("answers the stored metadata of a well-formed record", async () => {
    const root = await temporary()
    await result(root, "ab/ab01.json", JSON.stringify({ ...stored, outputs: [] }))
    expect(await CacheAdmin.inspect(root, ".flows", "ab01")).toEqual(stored)
  })
})

describe("removing results while the cache changes", () => {
  it("refuses to delete once the cache directory has moved", async () => {
    const root = await temporary()
    const entry = await result(root, "ab/ab01.json", "{}")
    const host = await changingHost(root, () => {
      NodeFs.renameSync(NodePath.join(root, ".flows/cache"), NodePath.join(root, ".flows/moved"))
    })
    await expect(prune(root, host)).rejects.toThrow("cache path changed during deletion")
    expect(await present(entry)).toBe(false)
    expect(await present(NodePath.join(root, ".flows/moved/ab/ab01.json"))).toBe(true)
  })

  it("refuses to delete through a shard replaced by a link", async () => {
    const root = await temporary()
    await result(root, "ab/ab01.json", "{}")
    const shard = NodePath.join(root, ".flows/cache/ab")
    const host = await changingHost(root, () => {
      NodeFs.renameSync(shard, `${shard}-held`)
      NodeFs.symlinkSync("ab-held", shard)
    })
    await expect(prune(root, host)).rejects.toThrow("cache shard changed during deletion")
    expect(await present(`${shard}-held/ab01.json`)).toBe(true)
  })

  it("leaves a result deleted or rewritten after listing and removes the rest", async () => {
    const root = await temporary()
    const gone = await result(root, "ab/ab01.json", "{}")
    const rewritten = await result(root, "ab/ab02.json", "{}")
    const stale = await result(root, "ab/ab03.json", "{\"a\":1}")
    const host = await changingHost(root, () => {
      NodeFs.unlinkSync(gone)
      NodeFs.writeFileSync(`${rewritten}.next`, "{\"fresh\":true}")
      NodeFs.renameSync(`${rewritten}.next`, rewritten)
    })
    const pruned = await prune(root, host)
    expect(pruned).toMatchObject({ candidates: 3, removed: 1, bytes: 7 })
    expect(await present(stale)).toBe(false)
    expect(await Fs.readFile(rewritten, "utf8")).toBe("{\"fresh\":true}")
  })

  it("reports no size accounting when no cap is given", async () => {
    const root = await temporary()
    const entry = await result(root, "ab/ab01.json", "{}")
    const pruned = await CacheAdmin.remove({ root, cacheDirectory: ".flows", dryRun: true, yes: false, now })
    expect(pruned).toEqual({
      scope: "local-action-results",
      dryRun: true,
      candidates: 1,
      candidateBytes: 2,
      removed: 0,
      bytes: 0,
      recoverable: false
    })
    expect(await present(entry)).toBe(true)
  })
})
