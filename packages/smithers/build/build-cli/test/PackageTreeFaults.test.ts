/**
 * Failure and boundary behavior of the write-set guard and the artifact
 * store: git that cannot start, dies, or emits a truncated character; dirty
 * paths that change kind or vanish behind git's back; portals too large or
 * unreadable to measure; outputs whose parents cannot be proven inside the
 * workspace; and publications that fail at each rename. Faults come from the
 * real filesystem (permissions, FIFOs, symlink loops, over-long names) or from
 * the `TreeIo` the module takes for exactly this purpose.
 */
import * as ChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as PackageTree from "../src/PackageTree.ts"

let base: string
let root: string
let outside: string

beforeEach(async () => {
  base = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-tree-faults-")))
  root = NodePath.join(base, "workspace")
  outside = NodePath.join(base, "outside")
  await Fs.mkdir(root, { recursive: true })
  await Fs.mkdir(outside, { recursive: true })
})

afterEach(async () => {
  // Restore search and write permission a test removed so the tree can be deleted.
  ChildProcess.execFileSync("chmod", ["-R", "u+rwx", base], { stdio: "ignore" })
  await Fs.rm(base, { recursive: true, force: true })
})

const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex")

const errnoError = (code: string, message: string = code): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code })

const git = (...args: Array<string>): string =>
  ChildProcess.execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })

/** A git workspace with `files` committed. */
const repository = async (files: Record<string, string> = {}): Promise<void> => {
  git("init", "--quiet", ".")
  for (const [path, text] of Object.entries(files)) {
    await Fs.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true })
    await Fs.writeFile(NodePath.join(root, path), text)
  }
  git("add", "-A")
  git("commit", "--quiet", "--allow-empty", "-m", "fixture")
}

const writeFile = async (relative: string, text: string): Promise<void> => {
  await Fs.mkdir(NodePath.dirname(NodePath.join(root, relative)), { recursive: true })
  await Fs.writeFile(NodePath.join(root, relative), text)
}

describe("runGit failures", () => {
  it("reports a git binary that cannot start", async () => {
    await Fs.mkdir(NodePath.join(root, ".git"))
    const previous = process.env.PATH
    process.env.PATH = NodePath.join(base, "empty-path")
    try {
      await expect(PackageTree.runGit(root, ["status"])).rejects.toThrow(/^git status failed: spawn git ENOENT/)
    } finally {
      process.env.PATH = previous
    }
  })

  it("names the exit code when git fails without stderr", async () => {
    await repository()
    await expect(PackageTree.runGit(root, ["-c", "alias.quiet=!exit 3", "quiet"]))
      .rejects.toThrow("git -c failed: exit 3")
  })

  it("names the signal when git is killed without stderr", async () => {
    await repository()
    await expect(PackageTree.runGit(root, ["-c", "alias.die=!kill -TERM $PPID", "die"]))
      .rejects.toThrow("git -c failed: SIGTERM")
  })

  it("refuses stdout that ends inside a multi-byte character", async () => {
    await repository()
    await expect(PackageTree.runGit(root, ["-c", "alias.cut=!printf '\\347'", "cut"]))
      .rejects.toThrow("git -c returned stdout that is not valid UTF-8")
  })
})

describe("runCommand", () => {
  it("returns stdout of a tool run with the inherited environment", async () => {
    await expect(PackageTree.runCommand("sh", ["-c", "printf ok"], { cwd: root })).resolves.toBe("ok")
  })

  it("rejects with what a failing tool wrote to stderr", async () => {
    await expect(PackageTree.runCommand("sh", ["-c", "echo broken >&2; exit 3"], { cwd: root }))
      .rejects.toThrow(/^broken$/)
  })

  it("rejects with the process failure when a failing tool is silent", async () => {
    await expect(PackageTree.runCommand("sh", ["-c", "exit 3"], { cwd: root })).rejects.toThrow(/Command failed/)
  })
})

describe("dirty-state census", () => {
  it("records a staged rename by its new path only", async () => {
    await repository({ "a.txt": "a\n" })
    git("mv", "a.txt", "b.txt")
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    try {
      expect([...snapshot.states.keys()]).toEqual(["b.txt"])
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("judges a dirty file replaced by a symlink as changed", async () => {
    await repository()
    await writeFile("u.txt", "untracked\n")
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    try {
      await Fs.rm(NodePath.join(root, "u.txt"))
      await Fs.symlink("elsewhere", NodePath.join(root, "u.txt"))
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual(["u.txt"])
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("judges a tracked file git is told not to watch as changed when it disappears", async () => {
    await repository({ "keep.txt": "keep\n", "dir/f.txt": "f\n" })
    git("update-index", "--assume-unchanged", "keep.txt", "dir/f.txt")
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    try {
      await Fs.rm(NodePath.join(root, "keep.txt"))
      await Fs.rm(NodePath.join(root, "dir"), { recursive: true })
      await writeFile("dir", "now a file\n")
      const changed = await PackageTree.changedSinceSnapshot(snapshot, ".flows")
      expect(changed).toEqual(expect.arrayContaining(["keep.txt", "dir/f.txt"]))
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails when a tracked file's mode cannot be read",
    async () => {
      await repository({ "locked/f.txt": "f\n" })
      git("update-index", "--assume-unchanged", "locked/f.txt")
      const snapshot = await PackageTree.snapshotTree(root, ".flows")
      try {
        await Fs.chmod(NodePath.join(root, "locked"), 0o000)
        await expect(PackageTree.changedSinceSnapshot(snapshot, ".flows")).rejects.toMatchObject({ code: "EACCES" })
      } finally {
        await Fs.chmod(NodePath.join(root, "locked"), 0o755)
        await PackageTree.releaseSnapshot(snapshot)
      }
    }
  )

  it("does not admit a change that resolves outside the workspace", async () => {
    await writeFile("inside.txt", "inside\n")
    await Fs.writeFile(NodePath.join(outside, "file.txt"), "outside\n")
    await Fs.symlink(outside, NodePath.join(root, "portal"))
    expect(PackageTree.judgedChanges(root, ["inside.txt", "portal/file.txt"], [""])).toEqual(["inside.txt"])
  })

  it("names a quarantine for a label with no usable characters", () => {
    const quarantine = PackageTree.openQuarantine(root, ".flows", "///")
    expect(quarantine.directory).toMatch(/^\.flows\/reverted\/body-/)
    expect(quarantine.held).toEqual([])
  })
})

describe.skipIf(process.platform === "win32")("revertPath", () => {
  it("restores a clean tracked symlink from the index", async () => {
    await repository({ "a.txt": "a\n" })
    await Fs.symlink("a.txt", NodePath.join(root, "link"))
    git("add", "link")
    git("commit", "--quiet", "-m", "link")
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    try {
      await Fs.rm(NodePath.join(root, "link"))
      await writeFile("link", "replaced\n")
      await PackageTree.revertPath(snapshot, "link")
      expect(await Fs.readlink(NodePath.join(root, "link"))).toBe("a.txt")
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("replaces a directory that took a clean tracked file's place", async () => {
    await repository({ "f.txt": "original\n" })
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    try {
      await Fs.rm(NodePath.join(root, "f.txt"))
      await writeFile("f.txt/inner.txt", "inner\n")
      await PackageTree.revertPath(snapshot, "f.txt")
      expect(await Fs.readFile(NodePath.join(root, "f.txt"), "utf8")).toBe("original\n")
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  const rollbackDirectories = async (): Promise<Array<string>> =>
    (await Fs.readdir(root)).filter((name) => name.startsWith(".smthrs-rollback-"))

  it("fails and removes staging when the destination cannot be inspected", async () => {
    await repository({ "f.txt": "original\n" })
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    const destination = NodePath.join(root, "f.txt")
    const io: PackageTree.TreeIo = {
      ...Fs,
      lstat: (path) => path === destination ? Promise.reject(errnoError("EACCES")) : Fs.lstat(path)
    }
    try {
      await writeFile("f.txt", "modified\n")
      await expect(PackageTree.revertPath(snapshot, "f.txt", undefined, io)).rejects.toMatchObject({ code: "EACCES" })
      expect(await Fs.readFile(destination, "utf8")).toBe("modified\n")
      expect(await rollbackDirectories()).toEqual([])
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("refuses an index entry that does not check out as a file or symlink", async () => {
    await repository({ "f.txt": "original\n" })
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    const io: PackageTree.TreeIo = {
      ...Fs,
      lstat: (path) => String(path).includes(".smthrs-rollback-") ? Fs.lstat(root) : Fs.lstat(path)
    }
    try {
      await writeFile("f.txt", "modified\n")
      await expect(PackageTree.revertPath(snapshot, "f.txt", undefined, io))
        .rejects.toThrow("cannot restore non-file index entry \"f.txt\"")
      expect(await Fs.readFile(NodePath.join(root, "f.txt"), "utf8")).toBe("modified\n")
      expect(await rollbackDirectories()).toEqual([])
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("removes a path that was deleted before the tool ran", async () => {
    await repository({ "gone.txt": "gone\n" })
    await Fs.rm(NodePath.join(root, "gone.txt"))
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    try {
      expect(snapshot.states.get("gone.txt")).toEqual({ kind: "missing" })
      await writeFile("gone.txt", "recreated\n")
      await PackageTree.revertPath(snapshot, "gone.txt")
      expect(NodeFs.existsSync(NodePath.join(root, "gone.txt"))).toBe(false)
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("restores a dirty symlink to its recorded target", async () => {
    await repository()
    await Fs.symlink("first", NodePath.join(root, "link"))
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    try {
      expect(snapshot.states.get("link")).toEqual({ kind: "link", target: "first" })
      await Fs.rm(NodePath.join(root, "link"))
      await writeFile("link", "replaced\n")
      await PackageTree.revertPath(snapshot, "link")
      expect(await Fs.readlink(NodePath.join(root, "link"))).toBe("first")
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })
})

describe.skipIf(process.platform === "win32")("portal census", () => {
  const fill = async (directory: string, count: number): Promise<void> => {
    await Fs.mkdir(directory, { recursive: true })
    for (let index = 0; index < count; index += 1) {
      await Fs.writeFile(NodePath.join(directory, `f${index}`), "")
    }
  }

  it("refuses a portal whose target crosses the entry cap, before and after the body runs", async () => {
    await fill(NodePath.join(outside, "big"), PackageTree.portalEntryCap + 1)
    await Fs.symlink(NodePath.join(outside, "big"), NodePath.join(root, "portal"))
    const refused = await PackageTree.snapshotPortals(root, ".flows").then(() => undefined, (cause: unknown) => cause)
    expect(refused).toBeInstanceOf(PackageTree.PortalCensusError)
    expect(refused).toMatchObject({
      reason: "too-large",
      link: "portal",
      message:
        `the write-set guard cannot confine portal: its target has more than ${PackageTree.portalEntryCap} entries`
    })

    await Fs.mkdir(NodePath.join(outside, "small"))
    await Fs.rm(NodePath.join(root, "portal"))
    await Fs.symlink(NodePath.join(outside, "small"), NodePath.join(root, "portal"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals.map((portal) => portal.link)).toEqual(["portal"])
      await Fs.rmdir(NodePath.join(outside, "small"))
      await Fs.rename(NodePath.join(outside, "big"), NodePath.join(outside, "small"))
      await expect(PackageTree.revertChangedPortals(snapshot)).rejects.toMatchObject({
        reason: "too-large",
        link: "portal"
      })
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })

  it.skipIf(process.getuid?.() === 0)("refuses a portal target that became unreadable after the snapshot", async () => {
    await Fs.mkdir(NodePath.join(outside, "parent/target"), { recursive: true })
    await Fs.symlink(NodePath.join(outside, "parent/target"), NodePath.join(root, "portal"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      await Fs.chmod(NodePath.join(outside, "parent"), 0o000)
      await expect(PackageTree.revertChangedPortals(snapshot)).rejects.toMatchObject({
        reason: "unreadable",
        link: "portal",
        cause: { code: "EACCES" }
      })
    } finally {
      await Fs.chmod(NodePath.join(outside, "parent"), 0o755)
      await PackageTree.releasePortals(snapshot)
    }
  })

  it("refuses a dangling portal whose target runs through a symlink loop", async () => {
    await Fs.symlink("loop", NodePath.join(outside, "loop"))
    await Fs.symlink(NodePath.join(outside, "loop", "x"), NodePath.join(root, "portal"))
    await expect(PackageTree.snapshotPortals(root, ".flows")).rejects.toMatchObject({
      reason: "unreadable",
      link: "portal",
      cause: { code: "ELOOP" }
    })
  })

  it("keeps the realpath failure as the cause when reading the link yields no error", async () => {
    await Fs.symlink(NodePath.join(outside, "missing"), NodePath.join(root, "portal"))
    const link = NodePath.join(root, "portal")
    const realpathFailure = errnoError("EIO", "realpath failed")
    const io: PackageTree.TreeIo = {
      ...Fs,
      realpath: ((path: string) =>
        path === link ? Promise.reject(realpathFailure) : Fs.realpath(path)) as PackageTree.TreeIo["realpath"],
      readlink: (() =>
        Promise.reject(undefined)) as PackageTree.TreeIo["readlink"]
    }
    await expect(PackageTree.snapshotPortals(root, ".flows", undefined, [], io)).rejects.toMatchObject({
      reason: "unreadable",
      link: "portal",
      cause: realpathFailure
    })
  })

  it("restores a removed file and a replaced symlink behind a portal", async () => {
    const target = NodePath.join(outside, "target")
    await Fs.mkdir(target)
    await Fs.writeFile(NodePath.join(target, "d.txt"), "data\n")
    await Fs.symlink("d.txt", NodePath.join(target, "s"))
    await Fs.symlink(target, NodePath.join(root, "portal"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals[0]!.states.get("s")).toEqual({ kind: "link", target: "d.txt" })
      await Fs.rm(NodePath.join(target, "d.txt"))
      await Fs.rm(NodePath.join(target, "s"))
      await Fs.writeFile(NodePath.join(target, "s"), "not a link\n")
      expect(await PackageTree.revertChangedPortals(snapshot)).toEqual(["portal/d.txt", "portal/s"])
      expect(await Fs.readFile(NodePath.join(target, "d.txt"), "utf8")).toBe("data\n")
      expect(await Fs.readlink(NodePath.join(target, "s"))).toBe("d.txt")
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })

  it("does not take an untracked nested repository for a portal", async () => {
    await repository()
    await Fs.mkdir(NodePath.join(root, "nested"))
    ChildProcess.execFileSync("git", ["init", "--quiet", "."], { cwd: NodePath.join(root, "nested"), stdio: "ignore" })
    expect(git("status", "--porcelain", "-z", "--untracked-files=all")).toContain("?? nested/")
    await Fs.symlink(outside, NodePath.join(root, "portal"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals.map((portal) =>
        portal.link
      )).toEqual(["portal"])
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })
})

describe("output capture boundaries", () => {
  it("refuses a missing outDir and an outDir that is a file", async () => {
    await expect(PackageTree.captureOutDir(root, ".flows", "out")).rejects.toThrow(
      "declared outDir was not created: out"
    )
    await writeFile("out", "file\n")
    await expect(PackageTree.captureOutDir(root, ".flows", "out")).rejects.toThrow(
      "declared outDir is not a directory: out"
    )
  })

  it.skipIf(process.platform === "win32")(
    "omits an entry that is neither a file, a directory, nor a link",
    async () => {
      await writeFile("out/a.txt", "a\n")
      ChildProcess.execFileSync("mkfifo", [NodePath.join(root, "out/pipe")])
      const manifest = await PackageTree.captureOutDir(root, ".flows", "out")
      expect(manifest.entries.map((entry) => entry.path)).toEqual(["a.txt"])
    }
  )

  it("refuses a file larger than the file ceiling before reading it", async () => {
    await writeFile("out/big.txt", "0123456789")
    await expect(
      PackageTree.captureOutDir(root, ".flows", "out", root, { ...PackageTree.outDirLimits, fileBytes: 4 })
    ).rejects.toMatchObject({
      limit: "fileBytes",
      message: "captured output out/big.txt crosses the fileBytes limit of 4"
    })
    expect(NodeFs.existsSync(NodePath.join(root, ".flows"))).toBe(false)
  })

  it("refuses a declared output file that leaves the workspace", async () => {
    await expect(PackageTree.captureFile(root, ".flows", "../escape.txt")).rejects.toThrow(
      "declared output file leaves the workspace: ../escape.txt"
    )
  })

  it.each([
    ["null", null],
    ["a string", "manifest"],
    ["a numeric path", { path: 1, digest: sha256("x"), executable: false }],
    ["an escaping path", { path: "../x", digest: sha256("x"), executable: false }]
  ])("decodes %s as no file manifest", (_name, value) => {
    expect(PackageTree.decodeFileManifest(value)).toBeUndefined()
  })

  it.each([
    ["null", null],
    ["a non-object entry", { outDir: "out", entries: [null] }]
  ])("decodes %s as no outDir manifest", (_name, value) => {
    expect(PackageTree.decodeManifest(value)).toBeUndefined()
  })
})

describe.skipIf(process.platform === "win32")("materializeFile proves the destination parent", () => {
  const manifest = (path: string): PackageTree.FileManifest => ({ path, digest: sha256("x"), executable: false })

  it("refuses a path that leaves the workspace", async () => {
    await expect(PackageTree.materializeFile(root, ".flows", manifest("../x.txt"))).rejects.toThrow(
      "materialize refused path: ../x.txt"
    )
  })

  it.skipIf(process.getuid?.() === 0)("refuses an ancestor it cannot search", async () => {
    await Fs.mkdir(NodePath.join(root, "locked"))
    await Fs.chmod(NodePath.join(root, "locked"), 0o000)
    await expect(PackageTree.materializeFile(root, ".flows", manifest("locked/sub/f.txt"))).rejects.toThrow(
      "declared output locked/sub/f.txt has no readable parent directory"
    )
  })

  it("walks past a file standing where a directory is needed and fails creating it", async () => {
    await writeFile("plain.txt", "plain\n")
    await expect(PackageTree.materializeFile(root, ".flows", manifest("plain.txt/sub/f.txt"))).rejects.toMatchObject({
      code: "ENOTDIR"
    })
  })

  it("refuses an ancestor that is a dangling symlink", async () => {
    await Fs.symlink(NodePath.join(root, "nowhere"), NodePath.join(root, "dangling"))
    await expect(PackageTree.materializeFile(root, ".flows", manifest("dangling/f.txt"))).rejects.toThrow(
      "declared output dangling/f.txt has no readable parent directory"
    )
  })

  it("refuses a parent that vanished after it was created", async () => {
    const io: PackageTree.TreeIo = { ...Fs, mkdir: (() => Promise.resolve(undefined)) as PackageTree.TreeIo["mkdir"] }
    await expect(PackageTree.materializeFile(root, ".flows", manifest("fresh/f.txt"), io)).rejects.toThrow(
      "declared output fresh/f.txt has no readable parent directory"
    )
  })

  it("publishes the file even when removing the spent temporary fails", async () => {
    await writeFile("source.txt", "payload\n")
    const captured = await PackageTree.captureFile(root, ".flows", "source.txt")
    const io: PackageTree.TreeIo = { ...Fs, rm: () => Promise.reject(errnoError("EBUSY")) }
    await PackageTree.materializeFile(root, ".flows", { ...captured, path: "restored/copy.txt" }, io)
    expect(await Fs.readFile(NodePath.join(root, "restored/copy.txt"), "utf8")).toBe("payload\n")
  })
})

describe.skipIf(process.platform === "win32")("materializeManifest publication", () => {
  /** Captures `out` holding `files` and returns its manifest. */
  const captured = async (files: Record<string, string>): Promise<PackageTree.OutDirManifest> => {
    for (const [path, text] of Object.entries(files)) await writeFile(`out/${path}`, text)
    const manifest = await PackageTree.captureOutDir(root, ".flows", "out")
    await Fs.rm(NodePath.join(root, "out"), { recursive: true })
    return manifest
  }

  const leftovers = async (): Promise<Array<string>> =>
    (await Fs.readdir(root)).filter((name) => name.startsWith(".smthrs-")).sort()

  it("restores an executable entry with execute permission", async () => {
    const manifest = await captured({ "run.sh": "#!/bin/sh\n" })
    await PackageTree.materializeManifest(root, ".flows", {
      ...manifest,
      entries: manifest.entries.map((entry) => ({ ...entry, executable: true }))
    })
    expect((await Fs.stat(NodePath.join(root, "out/run.sh"))).mode & 0o777).toBe(0o755)
  })

  it("tolerates a host that cannot sync the parent directory", async () => {
    const manifest = await captured({ "a.txt": "a\n" })
    const io: PackageTree.TreeIo = {
      ...Fs,
      open: ((path: string, flags: string) =>
        path === root ? Promise.reject(errnoError("EACCES")) : Fs.open(path, flags)) as PackageTree.TreeIo["open"]
    }
    await PackageTree.materializeManifest(root, ".flows", manifest, io)
    expect(await Fs.readFile(NodePath.join(root, "out/a.txt"), "utf8")).toBe("a\n")
  })

  it("fails publication on an I/O error syncing the parent directory", async () => {
    const manifest = await captured({ "a.txt": "a\n" })
    const io: PackageTree.TreeIo = {
      ...Fs,
      open: ((path: string, flags: string) =>
        path === root ? Promise.reject(errnoError("EIO")) : Fs.open(path, flags)) as PackageTree.TreeIo["open"]
    }
    await expect(PackageTree.materializeManifest(root, ".flows", manifest, io)).rejects.toMatchObject({ code: "EIO" })
    expect(await leftovers()).toEqual([])
  })

  it("fails without a lock when the destination name is too long to inspect", async () => {
    const manifest = await captured({ "a.txt": "a\n" })
    const outDir = "o".repeat(300)
    await expect(PackageTree.materializeManifest(root, ".flows", { ...manifest, outDir })).rejects.toMatchObject({
      code: "ENAMETOOLONG"
    })
    expect(await leftovers()).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)("reports a lock it cannot create as that failure, not contention", async () => {
    const manifest = await captured({ "a.txt": "a\n" })
    await Fs.mkdir(NodePath.join(root, "outs"))
    await Fs.chmod(NodePath.join(root, "outs"), 0o555)
    const refused = await PackageTree.materializeManifest(root, ".flows", { ...manifest, outDir: "outs/out" })
      .then(() =>
        undefined, (cause: unknown) =>
        cause)
    expect(refused).toMatchObject({ code: "EACCES" })
    expect(String(refused)).not.toContain("publication lock exists")
  })

  it("fails a first publication whose rename fails and removes the staged tree", async () => {
    const manifest = await captured({ "a.txt": "a\n" })
    const io: PackageTree.TreeIo = {
      ...Fs,
      rename: (from, to) =>
        NodePath.basename(String(from)).startsWith(".smthrs-mat-") ?
          Promise.reject(errnoError("EIO")) :
          Fs.rename(from, to)
    }
    await expect(PackageTree.materializeManifest(root, ".flows", manifest, io)).rejects.toMatchObject({ code: "EIO" })
    expect(NodeFs.existsSync(NodePath.join(root, "out"))).toBe(false)
    expect(await leftovers()).toEqual([])
  })

  it("names the preserved backup when neither publication nor restore succeeds", async () => {
    const manifest = await captured({ "a.txt": "new\n" })
    await writeFile("out/previous.txt", "previous\n")
    const io: PackageTree.TreeIo = {
      ...Fs,
      rename: (from, to) => {
        const name = NodePath.basename(String(from))
        if (name.startsWith(".smthrs-mat-")) return Promise.reject(errnoError("EIO", "publish failed"))
        if (name.startsWith(".smthrs-old-")) return Promise.reject(errnoError("EIO", "restore failed"))
        return Fs.rename(from, to)
      }
    }
    const refused = await PackageTree.materializeManifest(root, ".flows", manifest, io)
      .then(() => undefined, (cause: unknown) => cause)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toMatch(
      /^materialize could not publish out and could not restore the previous tree from .*\.smthrs-old-/
    )
    expect((refused as Error).cause).toMatchObject({ message: "restore failed" })
    const backups = (await leftovers()).filter((name) => name.startsWith(".smthrs-old-"))
    expect(backups).toHaveLength(1)
    expect(await Fs.readFile(NodePath.join(root, backups[0]!, "previous.txt"), "utf8")).toBe("previous\n")
  })
})

describe("treeMatchesManifest", () => {
  it("reports a captured symlink that is now a file or points elsewhere", async () => {
    const manifest: PackageTree.OutDirManifest = {
      outDir: "out",
      entries: [{ path: "l", kind: "link", digest: "", executable: false, target: "a" }]
    }
    await writeFile("out/l", "file\n")
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBe("out/l does not match the captured symlink")
    await Fs.rm(NodePath.join(root, "out/l"))
    await Fs.symlink("b", NodePath.join(root, "out/l"))
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBe("out/l does not match the captured symlink")
  })

  it("matches a captured tree with nested directories", async () => {
    await writeFile("out/a/b/c.txt", "c\n")
    const manifest = await PackageTree.captureOutDir(root, ".flows", "out")
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBeUndefined()
  })

  it("reports a tree nested deeper than any capture can be", async () => {
    const path = [...Array.from({ length: PackageTree.outDirLimits.depth + 2 }, () => "d"), "f.txt"].join("/")
    await writeFile(`out/${path}`, "deep\n")
    const manifest: PackageTree.OutDirManifest = {
      outDir: "out",
      entries: [{ path, kind: "file", digest: sha256("deep\n"), executable: false, target: "" }]
    }
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toMatch(
      /^out\/(d\/){64}d is deeper than the captured tree$/
    )
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a declared directory it cannot list",
    async () => {
      await writeFile("out/sub/f.txt", "f\n")
      const manifest = await PackageTree.captureOutDir(root, ".flows", "out")
      await Fs.chmod(NodePath.join(root, "out/sub"), 0o100)
      expect(await PackageTree.treeMatchesManifest(root, manifest)).toBe("out/sub could not be read")
    }
  )
})

describe("state measurement and blob verification", () => {
  it("measures a missing path, a file, and a symlink", async () => {
    await writeFile("f.txt", "f\n")
    await Fs.symlink("f.txt", NodePath.join(root, "l"))
    expect(await PackageTree.pathState(NodePath.join(root, "missing"))).toEqual({ kind: "missing" })
    expect(await PackageTree.pathState(NodePath.join(root, "f.txt"))).toMatchObject({
      kind: "file",
      digest: sha256("f\n")
    })
    expect(await PackageTree.pathState(NodePath.join(root, "l"))).toEqual({ kind: "link", target: "f.txt" })
  })

  it("judges a dirty symlink as changed only when its target changes", async () => {
    await repository()
    await Fs.symlink("first", NodePath.join(root, "link"))
    const snapshot = await PackageTree.snapshotTree(root, ".flows")
    try {
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual([])
      await Fs.rm(NodePath.join(root, "link"))
      await Fs.symlink("second", NodePath.join(root, "link"))
      expect(await PackageTree.changedSinceSnapshot(snapshot, ".flows")).toEqual(["link"])
    } finally {
      await PackageTree.releaseSnapshot(snapshot)
    }
  })

  it("verifies only file blobs and names a missing or tampered one", async () => {
    await writeFile("out/a.txt", "a\n")
    await Fs.symlink("a.txt", NodePath.join(root, "out/l"))
    const manifest = await PackageTree.captureOutDir(root, ".flows", "out")
    expect(await PackageTree.verifyManifestBlobs(root, ".flows", manifest)).toBeUndefined()
    const blob = NodePath.join(root, ".flows", ...(await casBlob(sha256("a\n"))))
    await Fs.writeFile(blob, "tampered\n")
    expect(await PackageTree.verifyManifestBlobs(root, ".flows", manifest)).toBe("cas blob tampered for out/a.txt")
    await Fs.rm(blob)
    expect(await PackageTree.verifyManifestBlobs(root, ".flows", manifest)).toBe("cas blob missing for out/a.txt")
  })

  it("reports a captured file whose content changed", async () => {
    await writeFile("out/a.txt", "a\n")
    const manifest = await PackageTree.captureOutDir(root, ".flows", "out")
    await writeFile("out/a.txt", "changed\n")
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBe("out/a.txt does not match the captured content")
  })

  it("decodes a file manifest with a malformed digest as nothing", () => {
    expect(PackageTree.decodeFileManifest({ path: "a.txt", digest: "nope", executable: false })).toBeUndefined()
  })
})

/** The CAS-relative location of one blob, found by name under the cache directory. */
const casBlob = async (digest: string): Promise<Array<string>> => {
  const found = (await Fs.readdir(NodePath.join(root, ".flows"), { recursive: true }))
    .find((path) => NodePath.basename(path) === digest)
  if (found === undefined) throw new Error(`no blob ${digest}`)
  return found.split(NodePath.sep)
}

describe.skipIf(process.platform === "win32")("ignored and portal census details", () => {
  it("skips a gitignored live runtime directory", async () => {
    await repository({ ".gitignore": ".smithers/runs/\nbuild/\n" })
    await writeFile(".smithers/runs/r1/log", "run\n")
    await writeFile("build/out.txt", "out\n")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      expect([...snapshot.entries.keys()]).toEqual(["build/out.txt"])
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("keeps a caller-owned stash when the census fails", async () => {
    await repository({ ".gitignore": "build/\n" })
    await writeFile("build/out.txt", "0123456789")
    const stash = await PackageTree.openIgnoredStash()
    try {
      await expect(
        PackageTree.snapshotIgnored(root, ".flows", { ...PackageTree.ignoredLimits, totalBytes: 4 }, stash)
      ).rejects.toMatchObject({ reason: "totalBytes" })
      expect(NodeFs.existsSync(stash.directory)).toBe(true)
    } finally {
      await PackageTree.releaseIgnoredStash(stash)
    }
  })

  it("measures nested directories and directory links behind a portal", async () => {
    const target = NodePath.join(outside, "target")
    await Fs.mkdir(NodePath.join(target, "nested"), { recursive: true })
    await Fs.writeFile(NodePath.join(target, "nested/f.txt"), "f\n")
    await Fs.symlink("nested", NodePath.join(target, "dirlink"))
    await Fs.symlink(target, NodePath.join(root, "portal"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect([...snapshot.portals[0]!.states.keys()].sort()).toEqual(["dirlink", "nested/f.txt"])
      await Fs.writeFile(NodePath.join(target, "nested/f.txt"), "changed\n")
      expect(await PackageTree.revertChangedPortals(snapshot)).toEqual(["portal/nested/f.txt"])
      expect(await Fs.readFile(NodePath.join(target, "nested/f.txt"), "utf8")).toBe("f\n")
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })
})
