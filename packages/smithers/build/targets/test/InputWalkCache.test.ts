import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as SafeFs from "../src/SafeFs.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

/** The real filesystem, counting directory listings and `.gitignore` reads by workspace-relative path. */
const counting = () => {
  const listed = new Map<string, number>()
  const opened = new Map<string, number>()
  const bump = (map: Map<string, number>, path: string) => {
    const relative = NodePath.relative(root, path)
    map.set(relative, (map.get(relative) ?? 0) + 1)
  }
  const io: SafeFs.Io = {
    ...SafeFs.defaultIo,
    readdir: (path, limit) => {
      bump(listed, path)
      return SafeFs.defaultIo.readdir(path, limit)
    },
    open: (path) => {
      bump(opened, path)
      return SafeFs.defaultIo.open(path)
    }
  }
  return { io, listed, opened }
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-walk-cache-")))
  await write(".gitignore", "*.log\n")
  await write("cases/helper.mjs", "export {}\n")
  await write("cases/c0/input.txt", "zero\n")
  await write("cases/c0/run.log", "ignored\n")
  await write("cases/c1/input.txt", "one\n")
  await write("cases/c1/.gitignore", "local.txt\n")
  await write("cases/c1/local.txt", "ignored here\n")
  await write("pkg/PACKAGE.ts", "export {}\n")
  await write("pkg/src/a.ts", "export const a = 1\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("Input.WalkCache", () => {
  it("lists each directory and reads each .gitignore once across expansions", async () => {
    const { io, listed, opened } = counting()
    const walks = Input.makeWalkCache()
    const patterns = ["cases/*.mjs", "cases/c0/**", "cases/c1/**", "**"]
    const shared = []
    for (const pattern of patterns) shared.push(await Input.expandGlob(root, "", pattern, { io, walks }))
    expect([...listed.values()].every((count) => count === 1)).toBe(true)
    expect(listed.get("cases/c1")).toBe(1)
    expect(opened.get(".gitignore")).toBe(1)
    expect(opened.get("cases/c1/.gitignore")).toBe(1)
    const fresh = []
    for (const pattern of patterns) fresh.push(await Input.expandGlob(root, "", pattern))
    expect(shared).toEqual(fresh)
    expect(shared[2]).toEqual(["cases/c1/.gitignore", "cases/c1/input.txt"])
  })

  it("keeps package scope and the unscoped walk apart over one cache", async () => {
    const walks = Input.makeWalkCache()
    const scoped = await Input.expandGlob(root, "", "**/*.ts", { walks })
    const unscoped = await Input.expandGlob(root, "", "**/*.ts", { walks, packageScoped: false })
    expect(scoped).toEqual([])
    expect(unscoped).toEqual(["pkg/PACKAGE.ts", "pkg/src/a.ts"])
  })

  it("still counts every directory and entry each expansion crosses against its limits", async () => {
    const walks = Input.makeWalkCache()
    await Input.expandGlob(root, "", "**", { walks })
    await expect(Input.expandGlob(root, "", "**", { walks, limits: { directories: 2 } })).rejects.toThrow(
      /directories limit/
    )
    await expect(Input.expandGlob(root, "", "**", { walks, limits: { entries: 3 } })).rejects.toThrow(
      /entries limit/
    )
    await expect(Input.expandGlob(root, "", "**", { walks, limits: { ignoreBytes: 8 } })).rejects.toThrow(
      /ignoreBytes limit/
    )
  })

  it("reads for itself through a different filesystem seam", async () => {
    const first = counting()
    const second = counting()
    const walks = Input.makeWalkCache()
    await Input.expandGlob(root, "", "cases/**", { io: first.io, walks })
    await Input.expandGlob(root, "", "cases/**", { io: second.io, walks })
    expect(second.listed.get("cases")).toBe(1)
  })

  it("answers a symbolic link once and keeps refusing one that leaves the workspace", async () => {
    const outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-walk-outside-")))
    try {
      await Fs.writeFile(NodePath.join(outside, "secret.txt"), "secret\n")
      await Fs.symlink(NodePath.join(outside, "secret.txt"), NodePath.join(root, "cases/c0/escape.txt"))
      await Fs.symlink("input.txt", NodePath.join(root, "cases/c0/alias.txt"))
      const walks = Input.makeWalkCache()
      const once = await Input.expandGlob(root, "", "cases/c0/**", { walks })
      const again = await Input.expandGlob(root, "", "cases/**", { walks })
      expect(once).toEqual(["cases/c0/alias.txt", "cases/c0/input.txt"])
      expect(again).toContain("cases/c0/alias.txt")
      expect(again).not.toContain("cases/c0/escape.txt")
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })
})
