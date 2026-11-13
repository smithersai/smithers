import * as SafeFs from "@smthrs/targets/SafeFs"
import type * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspace = async (): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-discovery-ceiling-")))
  temporaryDirectories.push(directory)
  await write(directory, "WORKSPACE.ts", "export const Workspace = 1\n")
  return directory
}

const dirent = (name: string, directory: boolean): NodeFs.Dirent =>
  ({
    name,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false
  }) as NodeFs.Dirent

/**
 * A virtual tree below `root`: every path is a directory whose listing
 * `children` chooses by depth. Only the walk lists through it; the workspace
 * declaration itself is admitted from the real root.
 */
const virtualTree = (root: string, children: (depth: number) => ReadonlyArray<NodeFs.Dirent>): SafeFs.Io => {
  const inodes = new Map<string, number>()
  return {
    ...SafeFs.defaultIo,
    realpath: async (path) => path,
    lstat: async (path) => {
      if (!inodes.has(path)) inodes.set(path, inodes.size + 1)
      return {
        dev: 1,
        ino: inodes.get(path)!,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false
      } as unknown as SafeFs.Stats
    },
    readdir: async (path) => {
      const relative = NodePath.relative(root, path)
      return children(relative === "" ? 0 : relative.split(NodePath.sep).length)
    }
  }
}

describe("PackageDiscovery ceilings and races", () => {
  it("skips a directory that disappears between its parent's listing and its own walk", async () => {
    const root = await workspace()
    await write(root, "kept/PACKAGE.ts", "export const Package = 1\n")
    await write(root, "gone/PACKAGE.ts", "export const Package = 1\n")
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      readdir: async (path, limit) => {
        const entries = await SafeFs.defaultIo.readdir(path, limit)
        if (path === root) await Fs.rm(NodePath.join(root, "gone"), { recursive: true, force: true })
        return entries
      }
    }
    const discovery = await PackageDiscovery.discover(root, { io })
    expect(discovery.packageFiles).toEqual(["kept/PACKAGE.ts"])
  })

  it("fails rather than truncates past 100,000 directories", async () => {
    const root = await workspace()
    const top = Array.from({ length: 1001 }, (_, index) => dirent(`d${index}`, true))
    const leaves = Array.from({ length: 100 }, (_, index) => dirent(`e${index}`, true))
    const io = virtualTree(root, (depth) => depth === 0 ? top : depth === 1 ? leaves : [])
    await expect(PackageDiscovery.discover(root, { io })).rejects.toMatchObject({
      code: "inventory_limit_exceeded",
      message: expect.stringContaining("directory limit of 100000")
    })
  }, 60_000)

  it("fails rather than truncates past 1,000,000 listed entries", async () => {
    const root = await workspace()
    const top = Array.from({ length: 11 }, (_, index) => dirent(`d${index}`, true))
    const files = Array.from({ length: 100_000 }, (_, index) => dirent(`f${index}`, false))
    const io = virtualTree(root, (depth) => depth === 0 ? top : files)
    await expect(PackageDiscovery.discover(root, { io })).rejects.toMatchObject({
      code: "inventory_limit_exceeded",
      message: expect.stringContaining("entry limit of 1000000")
    })
  }, 60_000)

  it("walks into a nested .smithers directory that declares no workspace", async () => {
    const root = await workspace()
    await write(root, "tools/.smithers/notes.txt", "not a workspace\n")
    await write(root, "tools/PACKAGE.ts", "export const Package = 1\n")
    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.packageFiles).toEqual(["tools/PACKAGE.ts"])
  })

  it("refuses two declaration paths that differ only by case", async () => {
    const root = await workspace()
    await write(root, "app/PACKAGE.ts", "export const Package = 1\n")
    await write(root, "App/PACKAGE.ts", "export const Package = 1\n")
    // A case-insensitive filesystem cannot hold both spellings.
    if ((await Fs.readdir(root)).filter((name) => name.toLowerCase() === "app").length < 2) return
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({
      code: "case_collision",
      path: "app/PACKAGE.ts",
      message: expect.stringContaining(
        "two declaration paths collide case-insensitively: App/PACKAGE.ts and app/PACKAGE.ts"
      )
    })
  })

  it("finds no workspace when the search climbs to the filesystem root", async () => {
    const start = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-discovery-orphan-")))
    temporaryDirectories.push(start)
    // Only meaningful while no ancestor of the temporary directory declares one.
    let ancestor = start
    for (let parent = NodePath.dirname(ancestor); parent !== ancestor; parent = NodePath.dirname(ancestor)) {
      ancestor = parent
      if (await PackageDiscovery.workspaceFileOf(ancestor) !== undefined) return
    }
    expect(await PackageDiscovery.findWorkspaceRoot(NodePath.join(start, "deeper", "still"))).toBeUndefined()
  })

  it("names the current directory as . when it is the invalid workspace root", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-discovery-cwd-")))
    temporaryDirectories.push(root)
    const previous = process.cwd()
    process.chdir(root)
    try {
      await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({ code: "workspace_root_invalid", path: "." })
    } finally {
      process.chdir(previous)
    }
  })
})
