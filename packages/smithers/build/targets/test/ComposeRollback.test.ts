/**
 * What `Generate` in check mode borrows from the tree, and what it puts back.
 *
 * The restore used to be bytes only, which is neither tree-preserving nor
 * symlink-safe: a chmod was invisible, a directory the generator created stayed
 * behind, and a symbolic link substituted for a declared output was written
 * *through*, landing the snapshot bytes on a file outside the declared tree.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"

import { PublicationFileSystem } from "../src/internal/PublicationFileSystem.ts"

let root: string
let outside: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rollback-")))
  outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rollback-outside-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

/** Runs a generator that is a `node -e` program, in check mode. */
const check = (program: string, changes: ReadonlyArray<string>, io: typeof Fs = Fs) =>
  Effect.runPromiseExit(
    Compose.checkGenerator({ workspaceRoot: root }, {
      run: {
        argv: [process.execPath, "-e", program],
        cwd: ".",
        env: {},
        secrets: [],
        expectedExitCodes: [0],
        timeoutMs: 30_000
      },
      changes: [...changes]
    } as never).pipe(Effect.provideService(PublicationFileSystem, io))
  )

describe("check-mode rollback", () => {
  it("restores contents and reports drift when the generator rewrites an output", async () => {
    await Fs.writeFile(NodePath.join(root, "out.txt"), "checked in\n")
    const exit = await check("require('node:fs').writeFileSync('out.txt', 'regenerated\\n')", ["out.txt"])
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("checked in\n")
  })

  it("reports and undoes a permissions-only change", async () => {
    const path = NodePath.join(root, "out.txt")
    await Fs.writeFile(path, "checked in\n", { mode: 0o644 })
    await Fs.chmod(path, 0o644)
    const exit = await check("require('node:fs').chmodSync('out.txt', 0o444)", ["out.txt"])
    expect(Exit.isFailure(exit)).toBe(true)
    const stats = await Fs.lstat(path)
    expect(stats.mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o644)
  })

  it("reports a removed output and restores its checked-in bytes", async () => {
    const path = NodePath.join(root, "out.txt")
    await Fs.writeFile(path, "checked in\n")
    const exit = await check("require('node:fs').unlinkSync('out.txt')", ["out.txt"])
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("generator removes it")
    expect(await Fs.readFile(path, "utf8")).toBe("checked in\n")
  })

  it("leaves an unchanged declared directory and its contents alone", async () => {
    await Fs.mkdir(NodePath.join(root, "out"))
    await Fs.writeFile(NodePath.join(root, "out", "kept.txt"), "kept\n")
    const exit = await check("void 0", ["out"])
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "out", "kept.txt"), "utf8")).toBe("kept\n")
  })

  it("reports and removes a directory tree the generator created", async () => {
    const exit = await check(
      "require('node:fs').mkdirSync('out', { recursive: true }); require('node:fs').writeFileSync('out/file.txt', 'new\\n')",
      ["out"]
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("out")
    expect(JSON.stringify(exit)).toContain("written by the generator")
    await expect(Fs.lstat(NodePath.join(root, "out"))).rejects.toThrow()
  })

  it("restores a deleted directory tree with its bytes and modes", async () => {
    const directory = NodePath.join(root, "out")
    const nested = NodePath.join(directory, "nested")
    const first = NodePath.join(directory, "first.txt")
    const second = NodePath.join(nested, "second.txt")
    await Fs.mkdir(nested, { recursive: true })
    await Fs.writeFile(first, "first checked in\n")
    await Fs.writeFile(second, "second checked in\n")
    await Fs.chmod(directory, 0o750)
    await Fs.chmod(nested, 0o710)
    await Fs.chmod(first, 0o640)
    await Fs.chmod(second, 0o600)

    const open = Fs.open
    // Model Windows' unsupported directory fchmod while keeping real handles.
    const io: typeof Fs = {
      ...Fs,
      open: async (...args) => {
        const handle = await open(...args)
        const chmod = handle.chmod.bind(handle)
        handle.chmod = async (mode) => {
          if ((await handle.stat()).isDirectory()) {
            throw Object.assign(new Error("directory fchmod denied"), { code: "EPERM" })
          }
          return chmod(mode)
        }
        return handle
      }
    }
    const exit = await check("require('node:fs').rmSync('out', { recursive: true })", ["out"], io)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("out")
    expect(JSON.stringify(exit)).toContain("generator removes it")
    expect(await Fs.readFile(first, "utf8")).toBe("first checked in\n")
    expect(await Fs.readFile(second, "utf8")).toBe("second checked in\n")
    expect((await Fs.lstat(directory)).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o750)
    expect((await Fs.lstat(nested)).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o710)
    expect((await Fs.lstat(first)).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o640)
    expect((await Fs.lstat(second)).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o600)
  })

  it("reports and restores a permissions-only change inside a declared directory", async () => {
    const directory = NodePath.join(root, "out")
    const path = NodePath.join(directory, "file.txt")
    await Fs.mkdir(directory)
    await Fs.writeFile(path, "checked in\n")
    await Fs.chmod(path, 0o640)

    const exit = await check("require('node:fs').chmodSync('out/file.txt', 0o444)", ["out"])

    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("out/file.txt")
    expect(JSON.stringify(exit)).toContain("changed its permissions")
    expect((await Fs.lstat(path)).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o640)
    expect(await Fs.readFile(path, "utf8")).toBe("checked in\n")
  })

  it("reports the first appended line when checked-in text is an exact prefix", async () => {
    await Fs.writeFile(NodePath.join(root, "out.txt"), "same")
    const exit = await check("require('node:fs').writeFileSync('out.txt', 'same\\nextra')", ["out.txt"])
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("first difference at line 2: (end of file) became \\\"extra\\\"")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("same")
  })

  it("never writes through a symbolic link the generator substituted for an output", async () => {
    const sentinel = NodePath.join(outside, "sentinel.txt")
    await Fs.writeFile(sentinel, "untouched\n")
    await Fs.writeFile(NodePath.join(root, "out.txt"), "checked in\n")
    const exit = await check(
      `const fs = require('node:fs'); fs.unlinkSync('out.txt'); fs.symlinkSync(${JSON.stringify(sentinel)}, 'out.txt')`,
      ["out.txt"]
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Fs.readFile(sentinel, "utf8")).toBe("untouched\n")
    const restored = await Fs.lstat(NodePath.join(root, "out.txt"))
    expect(restored.isSymbolicLink()).toBe(false)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("checked in\n")
  })

  it("refuses a symbolic link substituted for an output ancestor", async () => {
    const directory = NodePath.join(root, "out")
    const sentinel = NodePath.join(outside, "file.txt")
    await Fs.mkdir(directory)
    await Fs.writeFile(NodePath.join(directory, "file.txt"), "checked in\n")
    await Fs.writeFile(sentinel, "outside sentinel\n")

    const exit = await check(
      `const fs = require('node:fs'); fs.rmSync('out', { recursive: true }); fs.symlinkSync(${
        JSON.stringify(outside)
      }, 'out', 'dir')`,
      ["out/file.txt"]
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("symbolic link")
    expect(await Fs.readFile(sentinel, "utf8")).toBe("outside sentinel\n")
  })

  it("refuses a regular file standing where an output's parent directory belongs", async () => {
    await Fs.writeFile(NodePath.join(root, "out"), "not a directory\n")
    const exit = await check("require('node:fs').writeFileSync('unrelated.txt', 'x')", ["out/file.txt"])
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("non-directory ancestor")
    expect(await Fs.readFile(NodePath.join(root, "out"), "utf8")).toBe("not a directory\n")
  })

  it("refuses a declared write set that leaves the workspace", async () => {
    const sentinel = NodePath.join(outside, "sentinel.txt")
    await Fs.writeFile(sentinel, "untouched\n")
    const exit = await check("require('node:fs').writeFileSync('unrelated.txt', 'x')", ["../escape.txt"])
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("escapes the workspace")
    expect(await Fs.readFile(sentinel, "utf8")).toBe("untouched\n")
  })

  it("restores a checked-in symbolic link the generator replaced with a file", async () => {
    await Fs.writeFile(NodePath.join(root, "real.txt"), "real\n")
    await Fs.symlink("real.txt", NodePath.join(root, "link.txt"))
    const exit = await check(
      "const fs = require('node:fs'); fs.unlinkSync('link.txt'); fs.writeFileSync('link.txt', 'plain\\n')",
      ["link.txt"]
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const restored = await Fs.lstat(NodePath.join(root, "link.txt"))
    expect(restored.isSymbolicLink()).toBe(true)
    expect(await Fs.readlink(NodePath.join(root, "link.txt"))).toBe("real.txt")
  })

  it("removes an output the generator created where the checkout has none", async () => {
    const exit = await check("require('node:fs').writeFileSync('new.txt', 'x')", ["new.txt"])
    expect(Exit.isFailure(exit)).toBe(true)
    await expect(Fs.lstat(NodePath.join(root, "new.txt"))).rejects.toThrow()
  })

  it("leaves a matching tree alone and succeeds", async () => {
    await Fs.writeFile(NodePath.join(root, "out.txt"), "checked in\n")
    const exit = await check("require('node:fs').writeFileSync('out.txt', 'checked in\\n')", ["out.txt"])
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("checked in\n")
  })
})
