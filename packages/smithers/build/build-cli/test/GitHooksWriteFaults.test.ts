/**
 * Hook installation against real filesystem faults: a hooks path that runs
 * through a file, a hooks directory the user cannot write, and an obsolete
 * generated hook that cannot be deleted. Each is a typed refusal that names
 * the failing hook and leaves the directory as it was.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GitHooks from "../src/GitHooks.ts"

const roots: Array<string> = []
const locked: Array<string> = []
afterAll(async () => {
  for (const directory of locked) await Fs.chmod(directory, 0o755).catch(() => undefined)
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const repository = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-git-hooks-faults-")))
  roots.push(root)
  NodeChildProcess.execFileSync("git", ["init", "-q", root])
  return root
}

const lock = async (directory: string, mode: number): Promise<void> => {
  locked.push(directory)
  await Fs.chmod(directory, mode)
}

const isRoot = process.getuid?.() === 0

describe("GitHooks write faults", () => {
  it("refuses a core.hooksPath that runs through a regular file", async () => {
    const root = await repository()
    await Fs.writeFile(NodePath.join(root, "notes.txt"), "not a directory\n")
    NodeChildProcess.execFileSync("git", ["-C", root, "config", "core.hooksPath", "notes.txt/hooks"])
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    for (const action of ["install", "check"] as const) {
      await expect(GitHooks[action](root, rendered)).rejects.toMatchObject({
        code: "not_a_git_repository",
        message: expect.stringContaining("ENOTDIR")
      })
    }
    expect(await Fs.readFile(NodePath.join(root, "notes.txt"), "utf8")).toBe("not a directory\n")
  })

  it.skipIf(isRoot)("refuses to install into a hooks directory it cannot enter", async () => {
    const root = await repository()
    const hooks = NodePath.join(root, ".git", "hooks")
    await Fs.mkdir(hooks, { recursive: true })
    await lock(hooks, 0o000)
    await expect(GitHooks.install(root, GitHooks.render({ preCommit: "//:preCommit" }))).rejects.toMatchObject({
      code: "write_failed",
      message: expect.stringMatching(/^write_failed: pre-commit could not be installed: EACCES/)
    })
    await Fs.chmod(hooks, 0o755)
    expect((await Fs.readdir(hooks)).filter((name) => /^pre-commit($|\.tmp-)/.test(name))).toEqual([])
  })

  it.skipIf(isRoot)("refuses when an obsolete generated hook cannot be removed", async () => {
    const root = await repository()
    const hooks = NodePath.join(root, ".git", "hooks")
    expect(await GitHooks.install(root, GitHooks.render({ prePush: "//:old" }))).toEqual({ wrote: ["pre-push"] })
    await lock(hooks, 0o555)
    await expect(GitHooks.install(root, [])).rejects.toMatchObject({
      code: "write_failed",
      message: expect.stringMatching(/^write_failed: pre-push could not be removed: EACCES/)
    })
    await Fs.chmod(hooks, 0o755)
    expect(await Fs.readFile(NodePath.join(hooks, "pre-push"), "utf8")).toContain("//:old")
  })
})
