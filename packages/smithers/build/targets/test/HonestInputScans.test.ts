import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import * as Input from "../src/Input.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-source-scans-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

it("bounds raw glob exclusions and pattern text before scanning", async () => {
  await expect(Input.expandGlob(root, "", "**/*.ts", { exclude: Array(4097).fill("excluded") })).rejects.toThrow(
    /exclusions/
  )
  await expect(Input.expandGlob(root, "", "x".repeat(16385))).rejects.toThrow(/pattern exceeds/)
})

it("does not scan dependencies even when a glob starts inside node_modules", async () => {
  await Fs.mkdir(join(root, "node_modules"))
  await Fs.writeFile(join(root, "node_modules/dep.ts"), "export const value = 1")
  await expect(Input.expandGlob(root, "", "node_modules/**/*.ts")).resolves.toEqual([])
})

it("keeps nested repository sources opaque to a broad parent glob", async () => {
  await Fs.mkdir(join(root, "nested/.git"), { recursive: true })
  await Fs.writeFile(join(root, "nested/private.ts"), "export const privateValue = 1")
  await Fs.mkdir(join(root, "src"))
  await Fs.writeFile(join(root, "src/index.ts"), "export const value = 1")
  await expect(Input.expandGlob(root, "", "**/*.ts")).resolves.toEqual(["src/index.ts"])
})

it("refuses source discovery rooted at a file", async () => {
  const path = join(root, "file")
  await Fs.writeFile(path, "not a directory")
  await expect(Input.discoverFiles(path)).rejects.toThrow(/workspace is not a directory/)
})

it("inventories the workspace root literally, including files source scans ignore", async () => {
  await Fs.writeFile(join(root, ".gitignore"), "ignored\n")
  await Fs.writeFile(join(root, "ignored"), "produced")
  const files = await Input.listOutputFiles(root, ".")
  expect(files).toContain("ignored")
  expect(files).toContain(".gitignore")
})
