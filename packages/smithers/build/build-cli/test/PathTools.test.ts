import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PathTools from "../src/internal/PathTools.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const temporary = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-path-tools-")))
  roots.push(root)
  return root
}

const tools = [{ name: "node", path: "/opt/node/bin/node" }, { name: "go", path: "/opt/go/bin/go" }]

describe("the tool directory", () => {
  it("links each name to exactly its planned executable and is reused while it does", async () => {
    const parent = NodePath.join(await temporary(), "tmp")
    const directory = await PathTools.directory(parent, "0123456789abcdef", tools)
    expect(directory).toBe(NodePath.join(parent, "path-0123456789abcdef"))
    expect((await Fs.readdir(directory)).sort()).toEqual(["go", "node"])
    expect(await Fs.readlink(NodePath.join(directory, "node"))).toBe("/opt/node/bin/node")
    const before = await Fs.stat(directory)
    expect(await PathTools.directory(parent, "0123456789abcdef", tools)).toBe(directory)
    expect((await Fs.stat(directory)).ino).toBe(before.ino)
    // Nothing is left beside it.
    expect(await Fs.readdir(parent)).toEqual(["path-0123456789abcdef"])
  })

  it("is complete for every concurrent spawn of one node", async () => {
    const parent = await temporary()
    const directories = await Promise.all(
      Array.from({ length: 16 }, () => PathTools.directory(parent, "concurrent", tools))
    )
    expect(new Set(directories).size).toBe(1)
    expect(await Fs.readlink(NodePath.join(directories[0]!, "go"))).toBe("/opt/go/bin/go")
    expect(await Fs.readdir(parent)).toEqual(["path-concurrent"])
  })

  it.each(
    [
      ["another target", [{ name: "node", path: "/usr/bin/node" }, { name: "go", path: "/opt/go/bin/go" }]],
      ["one tool fewer", [{ name: "node", path: "/opt/node/bin/node" }]],
      ["a plain file", undefined]
    ] as const
  )("refuses a directory that holds %s", async (_name, existing) => {
    const parent = await temporary()
    const final = NodePath.join(parent, "path-taken")
    await Fs.mkdir(final)
    if (existing === undefined) {
      await Fs.writeFile(NodePath.join(final, "node"), "not a link")
      await Fs.symlink("/opt/go/bin/go", NodePath.join(final, "go"))
    } else for (const tool of existing) await Fs.symlink(tool.path, NodePath.join(final, tool.name))
    await expect(PathTools.directory(parent, "taken", tools)).rejects.toThrow("holds other tools")
    expect(await Fs.readdir(parent)).toEqual(["path-taken"])
  })

  it("leaves nothing behind when a link cannot be made", async () => {
    const parent = await temporary()
    await expect(PathTools.directory(parent, "id", [{ name: "sub/node", path: "/opt/node/bin/node" }])).rejects
      .toMatchObject({ code: "ENOENT" })
    expect(await Fs.readdir(parent)).toEqual([])
  })

  it("reports a parent it cannot create", async () => {
    const file = NodePath.join(await temporary(), "file")
    await Fs.writeFile(file, "")
    await expect(PathTools.directory(NodePath.join(file, "tmp"), "id", tools)).rejects.toMatchObject({
      code: "ENOTDIR"
    })
  })
})

describe("the directory of undeclared programs", () => {
  it("holds one failing program for each name on the search path the suite did not declare", async () => {
    const root = await temporary()
    const first = NodePath.join(root, "first")
    const second = NodePath.join(root, "second")
    for (
      const [directory, names] of [[first, ["zig", "strace", ".hidden"]], [second, ["strace", "other's"]]] as const
    ) {
      await Fs.mkdir(directory, { recursive: true })
      for (const name of names) await Fs.writeFile(NodePath.join(directory, name), "#!/bin/sh\n", { mode: 0o755 })
    }
    const parent = NodePath.join(root, "tmp")
    // A relative entry and a missing directory add nothing.
    const searchPath = ["relative", NodePath.join(root, "missing"), first, second].join(NodePath.delimiter)
    const directory = await PathTools.undeclared(parent, searchPath, ["zig"])
    expect((await Fs.readdir(directory)).sort()).toEqual(["other's", "strace"])
    const ran = spawnSync(NodePath.join(directory, "other's"), [], { encoding: "utf8" })
    expect(ran.status).toBe(127)
    expect(ran.stderr).toBe(`${PathTools.undeclaredLine("other's")}\n`)
    expect(ran.stderr).toBe("sandbox: other's is not declared: declare it in tools\n")
    // The same names give the same directory, made once.
    const before = await Fs.stat(directory)
    expect(await PathTools.undeclared(parent, searchPath, ["zig"])).toBe(directory)
    expect((await Fs.stat(directory)).ino).toBe(before.ino)
    // Two runs that make it at once both answer it, and nothing is left beside it.
    const [left, right] = await Promise.all([
      PathTools.undeclared(parent, first, []),
      PathTools.undeclared(parent, first, [])
    ])
    expect(left).toBe(right)
    expect((await Fs.readdir(left)).sort()).toEqual(["strace", "zig"])
    expect((await Fs.readdir(parent)).filter((name) => name.includes("."))).toEqual([])
  })
})
