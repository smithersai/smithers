import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GoCache from "../src/internal/GoCache.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map(async (root) => {
    await Fs.chmod(NodePath.join(root, ".flows", "go-build", "cd"), 0o755).catch(() => undefined)
    await Fs.rm(root, { recursive: true, force: true })
  }))
})

const temporary = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-cache-unreadable-")))
  roots.push(root)
  return root
}

const isRoot = process.getuid?.() === 0

describe("GoCache reads a cache that changes underneath it", () => {
  it.skipIf(isRoot)("lists entries in path order and skips an entry it cannot stat", async () => {
    const root = await temporary()
    const cache = ".flows/go-build"
    await write(root, `${cache}/ef/ef${"2".repeat(62)}-a`, "late")
    await write(root, `${cache}/ab/ab${"0".repeat(62)}-a`, "early")
    await write(root, `${cache}/ab/ab${"1".repeat(62)}-d`, "object")
    await write(root, `${cache}/cd/cd${"3".repeat(62)}-a`, "unreachable")
    // Listing a shard needs read permission; stat of its entries needs search permission.
    await Fs.chmod(NodePath.join(root, cache, "cd"), 0o444)
    const listed = await GoCache.entries(root, ".flows")
    expect(listed.map((entry) => NodePath.relative(NodePath.join(root, cache), entry.path))).toEqual([
      `ab/ab${"0".repeat(62)}-a`,
      `ab/ab${"1".repeat(62)}-d`,
      `ef/ef${"2".repeat(62)}-a`
    ])
    expect(listed.map((entry) => entry.bytes)).toEqual([5, 6, 4])
  })

  it("returns entries sorted by path whatever order the directory lists them in", async () => {
    const root = await temporary()
    const shards = Array.from({ length: 32 }, (_, index) => (index * 37 % 256).toString(16).padStart(2, "0"))
    for (const shard of shards) await write(root, `.flows/go-build/${shard}/${shard}${"0".repeat(62)}-a`, shard)
    const listed = await GoCache.entries(root, ".flows")
    const names = listed.map((entry) => NodePath.basename(NodePath.dirname(entry.path)))
    expect(names).toEqual([...shards].sort())
  })

  it("passes over a lease it cannot read as text and still honours the readable one", async () => {
    const root = await temporary()
    const now = 1_800_000_000_000
    const host: GoCache.LeaseHost = { now, host: "unit-host", alive: () => true }
    const leases = NodePath.join(root, ".flows", "go-build", "smthrs-leases")
    // A directory where a lease file belongs cannot be read; it is neither in use nor stale.
    await Fs.mkdir(NodePath.join(leases, "a-not-a-file.json"), { recursive: true })
    const lease = await GoCache.acquireLease(root, ".flows", { ...host, now: now - 5 * 3_600_000 })
    expect(await GoCache.usage(root, ".flows", host)).toEqual({ floor: now - 6 * 3_600_000, stale: [] })
    await GoCache.releaseLease(lease)
    expect(await GoCache.usage(root, ".flows", host)).toEqual({ floor: now - 3_600_000, stale: [] })
  })
})
