/**
 * The installed-tree identity, against real directories.
 *
 * Every case builds a `node_modules` tree in a temporary directory and
 * measures it. A faulty clock or reader is passed as the module's `Io`
 * parameter; nothing is replaced at module scope.
 */
import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as InstalledTree from "../src/internal/InstalledTree.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const posixIt = it.skipIf(process.platform === "win32")

const write = async (root: string, name: string, text: string, mode = 0o644): Promise<void> => {
  await Fs.mkdir(Path.dirname(Path.join(root, name)), { recursive: true })
  await Fs.writeFile(Path.join(root, name), text, { mode })
  await Fs.chmod(Path.join(root, name), mode)
}

/** A pnpm-shaped tree: a store, a top-level link into it, a bin shim and a tool's scratch. */
const tree = async (): Promise<string> => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-installed-tree-")))
  temporary.push(base)
  const root = Path.join(base, "node_modules")
  await write(root, ".pnpm/runner@1.0.0/node_modules/runner/package.json", "{\"name\":\"runner\"}")
  await write(root, ".pnpm/runner@1.0.0/node_modules/runner/bin/run.js", "console.log(1)\n", 0o755)
  await write(root, ".pnpm/lock.yaml", "lockfileVersion: '9.0'\n")
  await Fs.symlink(".pnpm/runner@1.0.0/node_modules/runner", Path.join(root, "runner"))
  await write(root, ".bin/runner", "#!/bin/sh\nexec node ../runner/bin/run.js\n", 0o755)
  await write(root, "@scope/plain/index.js", "export {}\n")
  await write(root, ".vite/results.json", "{}")
  await write(root, ".modules.yaml", "layoutVersion: 5\n")
  return root
}

/** A clock far enough ahead that every file counts as settled. */
const settled: InstalledTree.Io = { ...InstalledTree.defaultIo, now: () => BigInt(Date.now() + 60_000) * 1_000_000n }

describe("units", () => {
  it("names the bin directory, each store child and each entry without a leading dot", async () => {
    const root = await tree()
    expect(InstalledTree.units(root)).toEqual([
      ".bin",
      ".pnpm/lock.yaml",
      ".pnpm/runner@1.0.0",
      "@scope",
      "runner"
    ])
  })

  it("names a store that is not a directory as one unit", async () => {
    const root = await tree()
    await Fs.rm(Path.join(root, ".pnpm"), { recursive: true })
    await Fs.rm(Path.join(root, "runner"))
    await write(root, ".pnpm", "not a store\n")
    expect(InstalledTree.units(root)).toEqual([".bin", ".pnpm", "@scope"])
    expect(InstalledTree.identify(root).units).toBe(3)
  })
})

describe("identify", () => {
  it("answers one digest for one tree and a different one for each change a run could see", async () => {
    const root = await tree()
    const original = InstalledTree.identify(root)
    expect(original.units).toBe(5)
    // The tool's files, the store's lock, the shim and the scoped package; a link has no bytes.
    expect(original.files).toBe(5)
    expect(InstalledTree.identify(root)).toEqual(original)

    const changed = async (change: () => Promise<void>, restore: () => Promise<void>): Promise<void> => {
      await change()
      expect(InstalledTree.identify(root).digest).not.toBe(original.digest)
      await restore()
      expect(InstalledTree.identify(root).digest).toBe(original.digest)
    }
    const runner = ".pnpm/runner@1.0.0/node_modules/runner/bin/run.js"
    // The tool's own bytes, under one version.
    await changed(
      () => write(root, runner, "console.log(2)\n", 0o755),
      () => write(root, runner, "console.log(1)\n", 0o755)
    )
    // Its executable bit.
    await changed(() => Fs.chmod(Path.join(root, runner), 0o644), () => Fs.chmod(Path.join(root, runner), 0o755))
    // A file added beside it.
    await changed(
      () => write(root, ".pnpm/runner@1.0.0/node_modules/runner/extra.js", ""),
      () => Fs.rm(Path.join(root, ".pnpm/runner@1.0.0/node_modules/runner/extra.js"))
    )
    // A link pointed elsewhere.
    await changed(
      async () => {
        await Fs.rm(Path.join(root, "runner"))
        await Fs.symlink("@scope/plain", Path.join(root, "runner"))
      },
      async () => {
        await Fs.rm(Path.join(root, "runner"))
        await Fs.symlink(".pnpm/runner@1.0.0/node_modules/runner", Path.join(root, "runner"))
      }
    )
    // A package added at the top.
    await changed(() => write(root, "added/index.js", ""), () => Fs.rm(Path.join(root, "added"), { recursive: true }))
  })

  it("leaves a tool's scratch state under a dot name out of the identity", async () => {
    const root = await tree()
    const original = InstalledTree.identify(root)
    await write(root, ".vite/results.json", "{\"changed\":true}")
    await write(root, ".cache/anything", "x")
    await write(root, ".modules.yaml", "layoutVersion: 6\n")
    expect(InstalledTree.identify(root)).toEqual(original)
  })

  it("records a link by its target and never by what it points at", async () => {
    const root = await tree()
    const outside = Path.join(Path.dirname(root), "workspace-package")
    await write(outside, "index.js", "export const value = 1\n")
    await Fs.symlink("../workspace-package", Path.join(root, "linked"))
    const original = InstalledTree.identify(root)
    await write(outside, "index.js", "export const value = 2\n")
    expect(InstalledTree.identify(root)).toEqual(original)
  })

  posixIt("measures an entry that is neither a file, a link nor a directory by its name", async () => {
    const root = await tree()
    const original = InstalledTree.identify(root)
    execFileSync("mkfifo", [Path.join(root, "@scope/plain/pipe")])
    const withPipe = InstalledTree.identify(root)
    expect(withPipe.digest).not.toBe(original.digest)
    expect(withPipe.files).toBe(original.files)
  })

  it("reads a unit again only when its status changed", async () => {
    const root = await tree()
    const remembered = InstalledTree.empty()
    const reads: Array<string> = []
    const counting: InstalledTree.Io = {
      ...settled,
      read: (path, onChunk) => {
        reads.push(Path.relative(root, path))
        settled.read(path, onChunk)
      }
    }
    const first = InstalledTree.identify(root, remembered, counting)
    expect(reads.length).toBe(5)
    expect(remembered.changed).toBe(true)
    expect(remembered.rows.size).toBe(5)
    reads.length = 0
    remembered.changed = false
    expect(InstalledTree.identify(root, remembered, counting)).toEqual(first)
    expect(reads).toEqual([])
    expect(remembered.changed).toBe(false)
    // One unit changes: only its files are read.
    await write(root, "@scope/plain/index.js", "export const changed = true\n")
    const second = InstalledTree.identify(root, remembered, counting)
    expect(second.digest).not.toBe(first.digest)
    expect(reads).toEqual(["@scope/plain/index.js"])
    expect(remembered.changed).toBe(true)
  })

  it("never remembers a unit that changed just before it was read, and forgets what it knew of it", async () => {
    const root = await tree()
    const remembered = InstalledTree.empty()
    InstalledTree.identify(root, remembered, settled)
    expect(remembered.rows.size).toBe(5)
    remembered.changed = false
    // The host clock: the files were written within the last two seconds.
    await write(root, "@scope/plain/index.js", "export const changed = true\n")
    const fresh = InstalledTree.identify(root, remembered)
    expect(remembered.rows.has(Path.join(root, "@scope"))).toBe(false)
    expect(remembered.changed).toBe(true)
    // A unit never known and still unsettled is simply not added.
    const empty = InstalledTree.empty()
    expect(InstalledTree.identify(root, empty).digest).toBe(fresh.digest)
    expect(empty.rows.size).toBe(0)
    expect(empty.changed).toBe(false)
  })

  it("fails when the tree is deeper or larger than its limits", async () => {
    const root = await tree()
    expect(() => InstalledTree.identify(root, InstalledTree.empty(), settled, { entries: 1_000, depth: 2 })).toThrow(
      "deeper than 2 directories"
    )
    expect(() => InstalledTree.identify(root, InstalledTree.empty(), settled, { entries: 3, depth: 64 })).toThrow(
      "more than 3 entries"
    )
  })

  it("fails when a file cannot be read, so the caller never keys a tree it did not see", async () => {
    const root = await tree()
    const failing: InstalledTree.Io = {
      ...settled,
      read: () => {
        throw new Error("disk went away")
      }
    }
    expect(() => InstalledTree.identify(root, InstalledTree.empty(), failing)).toThrow("disk went away")
  })
})

describe("measure", () => {
  it("digests a directory, a single file, and answers absent for a missing path", async () => {
    const root = await tree()
    const directory = InstalledTree.measure(Path.join(root, "@scope"))
    expect(directory).toMatch(/^[0-9a-f]{64}$/)
    await write(root, "@scope/plain/index.js", "export const changed = true\n")
    expect(InstalledTree.measure(Path.join(root, "@scope"))).not.toBe(directory)
    const file = InstalledTree.measure(Path.join(root, ".pnpm/lock.yaml"))
    expect(file).toMatch(/^[0-9a-f]{64}$/)
    expect(file).not.toBe(directory)
    expect(InstalledTree.measure(Path.join(root, "missing"))).toBe("absent")
  })

  it("fails on a path it cannot read for any other reason", async () => {
    const root = await tree()
    expect(() => InstalledTree.measure(Path.join(root, ".pnpm/lock.yaml/below"))).toThrow(/ENOTDIR/)
  })

  it("fails when an entry below the path vanishes while it is read, instead of calling the path absent", async () => {
    const root = await tree()
    // The listing names an entry that is gone by the time it is read.
    const vanishing: InstalledTree.Io = {
      ...InstalledTree.defaultIo,
      readdir: (directory) => [
        ...InstalledTree.defaultIo.readdir(directory),
        ...(directory === Path.join(root, "@scope")
          ? InstalledTree.defaultIo.readdir(root).filter((entry) => entry.name === "runner").map((entry) =>
            Object.assign(entry, { name: "gone" })
          )
          : [])
      ]
    }
    expect(() => InstalledTree.measure(Path.join(root, "@scope"), vanishing)).toThrow(/ENOENT/)
    expect(InstalledTree.measure(Path.join(root, "@scope"))).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("remembered units on disk", () => {
  it("saves what a measurement changed and loads it back", async () => {
    const root = await tree()
    const file = InstalledTree.path(Path.dirname(root), ".flows")
    expect(file).toBe(Path.join(Path.dirname(root), ".flows", "plan", "installed-trees.json"))
    const remembered = InstalledTree.empty()
    const identity = InstalledTree.identify(root, remembered, settled)
    await InstalledTree.save(file, remembered)
    expect(remembered.changed).toBe(false)
    const loaded = await InstalledTree.load(file)
    expect(loaded.changed).toBe(false)
    expect([...loaded.rows]).toEqual([...remembered.rows].sort(([left], [right]) => (left < right ? -1 : 1)))
    // The loaded rows answer without a read.
    const unread: InstalledTree.Io = {
      ...settled,
      read: () => {
        throw new Error("read a remembered unit")
      }
    }
    expect(InstalledTree.identify(root, loaded, unread)).toEqual(identity)
    // Nothing changed, so nothing is written.
    const before = (await Fs.stat(file)).mtimeMs
    await InstalledTree.save(file, loaded)
    expect((await Fs.stat(file)).mtimeMs).toBe(before)
  })

  it("reports a save that cannot publish and leaves no temporary file", async () => {
    const root = await tree()
    const file = InstalledTree.path(Path.dirname(root), ".flows")
    // A directory where the file belongs: the rename cannot replace it.
    await Fs.mkdir(file, { recursive: true })
    const remembered = InstalledTree.empty()
    InstalledTree.identify(root, remembered, settled)
    await expect(InstalledTree.save(file, remembered)).rejects.toThrow()
    expect(NodeFs.readdirSync(Path.dirname(file))).toEqual(["installed-trees.json"])
    expect(remembered.changed).toBe(true)
  })

  it.each([
    ["a missing file", undefined],
    ["text that is not JSON", "{"],
    ["a value that is not an object", "7"],
    ["null", "null"],
    ["another format", JSON.stringify({ format: "other/1", rows: [] })],
    ["rows that are not a list", JSON.stringify({ format: "smthrs-installed-trees/1", rows: {} })]
  ])("ignores %s and reads every unit again", async (_name, text) => {
    const root = await tree()
    const file = Path.join(Path.dirname(root), "installed-trees.json")
    if (text !== undefined) await Fs.writeFile(file, text)
    const loaded = await InstalledTree.load(file)
    expect(loaded.rows.size).toBe(0)
    expect(loaded.changed).toBe(false)
  })

  it("ignores a directory and a file past the size limit", async () => {
    const root = await tree()
    const directory = Path.join(Path.dirname(root), "as-directory")
    await Fs.mkdir(directory)
    expect((await InstalledTree.load(directory)).rows.size).toBe(0)
    const large = Path.join(Path.dirname(root), "large.json")
    await Fs.writeFile(large, JSON.stringify({ format: "smthrs-installed-trees/1", rows: [] }))
    // Sparse: the size is what the limit reads, and no block is written.
    await Fs.truncate(large, 64 * 1024 * 1024 + 1)
    expect((await InstalledTree.load(large)).rows.size).toBe(0)
  })

  it("keeps the well-formed rows of a file and drops each malformed one", async () => {
    const root = await tree()
    const file = Path.join(Path.dirname(root), "installed-trees.json")
    const digest = "a".repeat(64)
    await Fs.writeFile(
      file,
      JSON.stringify({
        format: "smthrs-installed-trees/1",
        rows: [
          ["/kept", digest, digest, 3],
          "not a row",
          ["/short", digest, digest],
          [7, digest, digest, 1],
          ["/bad-fingerprint", "zz", digest, 1],
          ["/fingerprint-not-text", 1, digest, 1],
          ["/bad-digest", digest, "zz", 1],
          ["/digest-not-text", digest, 1, 1],
          ["/count-not-number", digest, digest, "1"],
          ["/count-fraction", digest, digest, 1.5],
          ["/count-negative", digest, digest, -1]
        ]
      })
    )
    const loaded = await InstalledTree.load(file)
    expect([...loaded.rows]).toEqual([["/kept", { fingerprint: digest, digest, files: 3 }]])
  })
})

describe("difference", () => {
  /** Long enough that a write after it carries a later status change than every entry before it. */
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))
  const inRunner = ".pnpm/runner@1.0.0/node_modules/runner"

  it("answers nothing for two measurements of one tree", async () => {
    const root = await tree()
    const before = InstalledTree.identify(root)
    await write(root, ".vite/results.json", "{\"changed\":true}")
    expect(InstalledTree.difference(root, before, InstalledTree.identify(root))).toBeUndefined()
  })

  it("names the unit and the file a tool wrote beside its own program", async () => {
    const root = await tree()
    const before = InstalledTree.identify(root)
    await tick()
    await write(root, `${inRunner}/native`, "binary\n", 0o755)
    const change = InstalledTree.difference(root, before, InstalledTree.identify(root))
    expect(change).toEqual({
      unit: ".pnpm/runner@1.0.0",
      kind: "written",
      paths: ["node_modules/runner/native"],
      morePaths: 0,
      moreUnits: 0
    })
    expect(InstalledTree.describeChange("node_modules", change!)).toBe(
      "node_modules unit .pnpm/runner@1.0.0: node_modules/runner/native was written"
    )
  })

  it("names a rewritten file, and the directory a file was removed from", async () => {
    const root = await tree()
    const before = InstalledTree.identify(root)
    await tick()
    await write(root, `${inRunner}/bin/run.js`, "console.log(2)\n", 0o755)
    expect(InstalledTree.difference(root, before, InstalledTree.identify(root))?.paths).toEqual([
      "node_modules/runner/bin/run.js"
    ])
    const rewritten = InstalledTree.identify(root)
    await tick()
    await Fs.rm(Path.join(root, inRunner, "bin/run.js"))
    expect(InstalledTree.difference(root, rewritten, InstalledTree.identify(root))?.paths).toEqual([
      "node_modules/runner/bin"
    ])
  })

  it("names a unit that is itself the entry written", async () => {
    const root = await tree()
    const before = InstalledTree.identify(root)
    await tick()
    await Fs.rm(Path.join(root, "runner"))
    await Fs.symlink("@scope/plain", Path.join(root, "runner"))
    const change = InstalledTree.difference(root, before, InstalledTree.identify(root))
    expect(change).toMatchObject({ unit: "runner", kind: "written", paths: ["."] })
    expect(InstalledTree.describeChange("node_modules", change!)).toBe("node_modules unit runner: . was written")
  })

  it("names a unit that appeared or disappeared, and counts the other units that differ", async () => {
    const root = await tree()
    const before = InstalledTree.identify(root)
    await write(root, "added/index.js", "")
    const added = InstalledTree.difference(root, before, InstalledTree.identify(root))
    expect(added).toEqual({ unit: "added", kind: "added", paths: [], morePaths: 0, moreUnits: 0 })
    expect(InstalledTree.describeChange("pkg/node_modules", added!)).toBe("pkg/node_modules unit added was added")
    await Fs.rm(Path.join(root, "@scope"), { recursive: true })
    await Fs.rm(Path.join(root, ".bin"), { recursive: true })
    const several = InstalledTree.difference(root, before, InstalledTree.identify(root))
    expect(several).toEqual({ unit: ".bin", kind: "removed", paths: [], morePaths: 0, moreUnits: 2 })
    expect(InstalledTree.describeChange("node_modules", several!)).toBe(
      "node_modules unit .bin was removed; 2 more units changed"
    )
  })

  it("names the first paths written in a unit and counts the rest", async () => {
    const root = await tree()
    const before = InstalledTree.identify(root)
    await tick()
    for (const name of ["a", "b", "c", "d", "e"]) await write(root, `${inRunner}/${name}.js`, name)
    await write(root, "@scope/plain/index.js", "export const changed = true\n")
    const change = InstalledTree.difference(root, before, InstalledTree.identify(root))
    expect(change).toEqual({
      unit: ".pnpm/runner@1.0.0",
      kind: "written",
      paths: ["node_modules/runner/a.js", "node_modules/runner/b.js", "node_modules/runner/c.js"],
      morePaths: 2,
      moreUnits: 1
    })
    expect(InstalledTree.describeChange("node_modules", change!)).toBe(
      "node_modules unit .pnpm/runner@1.0.0: node_modules/runner/a.js, node_modules/runner/b.js, " +
        "node_modules/runner/c.js and 2 more were written; 1 more unit changed"
    )
  })

  it("still names the unit when no entry is newer than the first measurement", async () => {
    const root = await tree()
    const measured = InstalledTree.identify(root)
    // A first measurement taken in the same clock tick as the write that followed it.
    const before = {
      ...measured,
      byUnit: new Map([...measured.byUnit].map(([unit, row]) => [unit, { ...row, latest: 2n ** 62n }]))
    }
    await write(root, `${inRunner}/native`, "binary\n")
    const change = InstalledTree.difference(root, before, InstalledTree.identify(root))
    expect(change).toEqual({ unit: ".pnpm/runner@1.0.0", kind: "written", paths: [], morePaths: 0, moreUnits: 0 })
    expect(InstalledTree.describeChange("node_modules", change!)).toBe("node_modules unit .pnpm/runner@1.0.0 changed")
  })

  it("says two paths were written", () => {
    expect(
      InstalledTree.describeChange("node_modules", {
        unit: "tool",
        kind: "written",
        paths: ["a", "b"],
        morePaths: 0,
        moreUnits: 0
      })
    ).toBe("node_modules unit tool: a, b were written")
  })
})
