import type { Dirent } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type Directory, readDirectory } from "../src/internal/ReadDirectory.ts"
import * as SafeFs from "../src/SafeFs.ts"

let root: string
let entries: Array<Dirent>

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-directory-"))
  await Fs.writeFile(NodePath.join(root, "a.txt"), "a")
  await Fs.writeFile(NodePath.join(root, "b.txt"), "b")
  entries = await Fs.readdir(root, { withFileTypes: true })
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/** An opened directory with local failure state, never a module replacement. */
const directory = (faults: { readonly read?: Error; readonly close?: Error } = {}) => {
  const events: Array<string> = []
  let index = 0
  const opened: Directory = {
    read: async () => {
      events.push("read")
      if (faults.read !== undefined) throw faults.read
      return entries[index++] ?? null
    },
    close: async () => {
      events.push("close")
      if (faults.close !== undefined) throw faults.close
    }
  }
  return { opened, events }
}

describe("readDirectory", () => {
  it("drains a real directory and closes its descriptor", async () => {
    const opened = await Fs.opendir(root)
    const result = await readDirectory(opened, 2)
    expect(result.map((entry) => entry.name).sort()).toEqual(["a.txt", "b.txt"])
    await expect(opened.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" })
  })

  it("returns an empty directory and closes its descriptor", async () => {
    const empty = NodePath.join(root, "empty")
    await Fs.mkdir(empty)
    const opened = await Fs.opendir(empty)
    expect(await readDirectory(opened, 0)).toEqual([])
    await expect(opened.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" })
  })

  it.each(["read", "close", "both"] as const)("preserves the first %s failure and closes once", async (failure) => {
    const read = new Error("directory read failed")
    const close = new Error("directory close failed")
    const { opened, events } = directory({
      ...(failure === "close" ? {} : { read }),
      ...(failure === "read" ? {} : { close })
    })
    await expect(readDirectory(opened, 2)).rejects.toBe(failure === "close" ? close : read)
    expect(events).toEqual(failure === "close" ? ["read", "read", "read", "close"] : ["read", "close"])
  })

  it.each([0, 1])("returns only one sentinel past a limit of %s", async (limit) => {
    const { opened, events } = directory()
    expect(await readDirectory(opened, limit)).toEqual(entries.slice(0, limit + 1))
    expect(events).toEqual([...Array<string>(limit + 1).fill("read"), "close"])
  })

  it.each([false, true])("rejects overflow before a close failure of %s", async (closeFails) => {
    const { opened, events } = directory(closeFails ? { close: new Error("directory close failed") } : {})
    await expect(readDirectory(opened, 0, "too many entries")).rejects.toThrow("too many entries")
    expect(events).toEqual(["read", "close"])
  })

  it("keeps confined reads strict at the directory limit", async () => {
    await expect(SafeFs.defaultIo.readdir(root, 1)).rejects.toThrow(`directory contains more than 1 entries: ${root}`)
    expect((await SafeFs.defaultIo.readdir(root, 2)).map((entry) => entry.name).sort()).toEqual(["a.txt", "b.txt"])
  })
})
