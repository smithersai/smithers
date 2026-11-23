import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const hasJj = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasJj)("Affected.changedPaths in Jujutsu workspaces", () => {
  it("discovers changed files in a non-colocated jj repository", async () => {
    const root = await tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-affected-jj-"))))
    execFileSync("jj", ["git", "init", root], { stdio: "ignore" })
    await write(root, "src/a.zig", "pub const a = 1;\n")
    await write(root, "src/b.zig", "pub const b = 2;\n")
    execFileSync("jj", ["--no-pager", "commit", "-m", "initial"], { cwd: root, stdio: "ignore" })

    await write(root, "src/a.zig", "pub const a = 42;\n")
    await write(root, "src/c.zig", "pub const c = 3;\n")

    const paths = await Affected.changedPaths(root, { base: "HEAD" })
    expect(paths).toEqual(["src/a.zig", "src/c.zig"])
  })
})
