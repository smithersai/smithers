import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { resolve, join } from "node:path"
import { stagePackageProject } from "./run"

test("failed package copying removes the partially staged workspace", async () => {
  let root: string | undefined
  const copyError = new Error("injected copy failure after writing partial data")
  const copy = spyOn(fs, "cp").mockImplementation(async (_source, destination) => {
    root = resolve(String(destination), "../../..")
    await fs.mkdir(String(destination), { recursive: true })
    await fs.writeFile(join(String(destination), "partial"), "copied data")
    throw copyError
  })
  try {
    await expect(stagePackageProject()).rejects.toBe(copyError)
    expect(root).toBeDefined()
    expect(await fs.access(root!).then(() => true, () => false)).toBe(false)
  } finally {
    copy.mockRestore()
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true })
  }
})

test("failed staging preserves both the copy and cleanup errors", async () => {
  let root: string | undefined
  const copyError = new Error("injected copy failure")
  const cleanupError = new Error("injected cleanup failure")
  const copy = spyOn(fs, "cp").mockImplementation(async (_source, destination) => {
    root = resolve(String(destination), "../../..")
    throw copyError
  })
  const remove = spyOn(fs, "rm").mockRejectedValue(cleanupError)
  try {
    const error = await stagePackageProject().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([copyError, cleanupError])
  } finally {
    copy.mockRestore()
    remove.mockRestore()
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true })
  }
})
