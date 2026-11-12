import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as SafeFs from "../src/SafeFs.ts"

let root: string

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

/** The real filesystem, counting the files it opens. */
const counting = () => {
  const opened: Array<string> = []
  const io: SafeFs.Io = {
    ...SafeFs.defaultIo,
    open: (path) => {
      opened.push(path)
      return SafeFs.defaultIo.open(path)
    }
  }
  return { io, opened }
}

const write = async (relative: string, text: string): Promise<string> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text)
  return path
}

/** An index whose clock reads past the settle window: a later invocation's view of files written now. */
const later = (rows: Iterable<readonly [string, SafeFs.DigestRow]> = []) =>
  SafeFs.makeDigestIndex(rows, () => BigInt(Date.now()) * 1_000_000n + SafeFs.settledNanoseconds + 1_000_000_000n)

const digest = (path: string, io: SafeFs.Io, digests?: SafeFs.DigestIndex) =>
  SafeFs.digestFile(path, { root, io, digests })

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-digest-index-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("SafeFs digest index", () => {
  it("answers a settled, unchanged file without opening it", async () => {
    const path = await write("a.txt", "alpha\n")
    const digests = later()
    const { io, opened } = counting()
    expect(await digest(path, io, digests)).toBe(sha256("alpha\n"))
    const next = later(digests.rows)
    expect(await digest(path, io, next)).toBe(sha256("alpha\n"))
    expect(opened).toEqual([path])
    expect([...next.used]).toEqual([path])
  })

  it("reads a file again after a same-size rewrite that restores its modification time", async () => {
    const path = await write("a.txt", "alpha\n")
    const digests = later()
    const { io, opened } = counting()
    expect(await digest(path, io, digests)).toBe(sha256("alpha\n"))
    const { atime, mtime } = await Fs.stat(path)
    // Past the coarsest kernel timestamp tick, so the rewrite's status-change time differs.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await Fs.writeFile(path, "omega\n")
    await Fs.utimes(path, atime, mtime)
    expect(await digest(path, io, later(digests.rows))).toBe(sha256("omega\n"))
    expect(opened).toEqual([path, path])
  })

  it("reads a file again after it is replaced by another inode with the same times", async () => {
    const path = await write("a.txt", "alpha\n")
    const digests = later()
    const { io } = counting()
    await digest(path, io, digests)
    const { atime, mtime } = await Fs.stat(path)
    const replacement = await write("b.txt", "omega\n")
    await Fs.utimes(replacement, atime, mtime)
    await Fs.rename(replacement, path)
    expect(await digest(path, io, later(digests.rows))).toBe(sha256("omega\n"))
  })

  it("reuses an unsettled file's digest within the invocation and marks it unsettled", async () => {
    const path = await write("a.txt", "alpha\n")
    const digests = SafeFs.makeDigestIndex()
    const { io, opened } = counting()
    expect(await digest(path, io, digests)).toBe(sha256("alpha\n"))
    expect(await digest(path, io, digests)).toBe(sha256("alpha\n"))
    expect(opened).toEqual([path])
    expect(digests.rows.get(path)?.settled).toBe(false)
  })

  it("marks a file settled when its times predate the read by the settle window", async () => {
    const path = await write("a.txt", "alpha\n")
    const digests = later()
    await digest(path, SafeFs.defaultIo, digests)
    expect(digests.rows.get(path)?.settled).toBe(true)
  })

  it("never answers from a row whose status differs, and replaces it", async () => {
    const path = await write("a.txt", "alpha\n")
    const status = SafeFs.digestStatus(await Fs.lstat(path, { bigint: true }))!
    const digests = SafeFs.makeDigestIndex([[path, { status: `${status}0`, digest: sha256("stale"), settled: true }]])
    const { io } = counting()
    expect(await digest(path, io, digests)).toBe(sha256("alpha\n"))
    expect(digests.rows.get(path)?.digest).toBe(sha256("alpha\n"))
  })

  it("leaves digests unchanged and every file read without an index", async () => {
    const path = await write("a.txt", "alpha\n")
    const { io, opened } = counting()
    const withIndex = later()
    expect(await digest(path, io, withIndex)).toBe(await digest(path, io))
    expect(await digest(path, io)).toBe(sha256("alpha\n"))
    expect(opened).toEqual([path, path, path])
  })

  it("keeps confinement ahead of a remembered row", async () => {
    const outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-digest-outside-")))
    try {
      await Fs.writeFile(NodePath.join(outside, "secret.txt"), "secret\n")
      const link = NodePath.join(root, "link.txt")
      await Fs.symlink(NodePath.join(outside, "secret.txt"), link)
      const status = SafeFs.digestStatus(await Fs.stat(NodePath.join(outside, "secret.txt"), { bigint: true }))!
      const digests = SafeFs.makeDigestIndex([[link, { status, digest: sha256("secret\n"), settled: true }]])
      await expect(digest(link, SafeFs.defaultIo, digests)).rejects.toThrow(/leaving the workspace/)
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("identifies a file by its numeric stats when the host gives no nanoseconds", async () => {
    const path = await write("a.txt", "alpha\n")
    const stats = await Fs.lstat(path)
    expect(SafeFs.digestStatus(stats)).toBe(
      `${stats.dev}:${stats.ino}:${stats.size}:${BigInt(Math.trunc(stats.mtimeMs * 1_000_000))}:${
        BigInt(Math.trunc(stats.ctimeMs * 1_000_000))
      }`
    )
    expect(SafeFs.digestStatus({ ...stats, mtimeMs: Number.NaN } as typeof stats)).toBeUndefined()
  })

  it("is shared through Input.digestFiles and Input.digestFile", async () => {
    await write("a.txt", "alpha\n")
    await write("b.txt", "beta\n")
    const digests = later()
    const { io, opened } = counting()
    const first = await Input.digestFiles(root, ["a.txt", "b.txt"], { io, digests })
    const again = await Input.digestFiles(root, ["b.txt", "a.txt"], { io, digests })
    const one = await Input.digestFile(NodePath.join(root, "a.txt"), { workspaceRoot: root, io, digests })
    expect(again).toEqual(first)
    expect(one).toBe(sha256("alpha\n"))
    expect(opened.length).toBe(2)
  })

  it("resolves a path once per invocation, and asks again after a failure", async () => {
    const path = await write("a.txt", "alpha\n")
    await Fs.mkdir(NodePath.join(root, "dir.txt"))
    const statted: Array<string> = []
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      lstat: (candidate) => {
        statted.push(NodePath.relative(root, candidate))
        return SafeFs.defaultIo.lstat(candidate)
      }
    }
    const digests = SafeFs.makeDigestIndex()
    expect(await digest(path, io, digests)).toBe(sha256("alpha\n"))
    expect(await digest(path, io, digests)).toBe(sha256("alpha\n"))
    expect(await digest(NodePath.join(root, "missing.txt"), io, digests)).toBeUndefined()
    expect(await digest(NodePath.join(root, "missing.txt"), io, digests)).toBeUndefined()
    const directory = NodePath.join(root, "dir.txt")
    await expect(digest(directory, io, digests)).rejects.toThrow(/not a regular file/)
    await expect(digest(directory, io, digests)).rejects.toThrow(/not a regular file/)
    expect(statted.filter((name) => name === "a.txt")).toHaveLength(2)
    expect(statted.filter((name) => name === "missing.txt")).toHaveLength(1)
    expect(statted.filter((name) => name === "dir.txt")).toHaveLength(2)
  })
})
