import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { childEnvironment } from "./support/node-child.ts"

const cli = resolve(import.meta.dirname, "../bin/smithers.mjs")
describe("npm CLI in a real jj checkout", () => {
  it("shares change and bookmark state with jj and preserves uncommitted file diffs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-cli-jj-"))
    const env = childEnvironment({
      ...process.env,
      JJ_USER: "CLI test",
      JJ_EMAIL: "cli@example.test",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
    })
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { cwd: directory, env, encoding: "utf8", timeout: 30000 })
    const invoke = (args: string[]) => JSON.parse(run(process.execPath, [cli, ...args, "--json"]))
    try {
      run("jj", ["git", "init"])
      await writeFile(join(directory, "hello.txt"), "hello world\n")
      run("jj", ["describe", "-m", "CLI change"])
      const status = invoke(["change", "status"])
      expect(status.working_copy.description).toBe("CLI change")
      expect(status.files).toContainEqual({ status: "A", path: "hello.txt" })
      expect(invoke(["change", "diff"]).diff).toContain("hello world")
      expect(invoke(["change", "show", "@"]).change_id).toBe(status.working_copy.change_id)
      const ambiguous = spawnSync(process.execPath, [cli, "change", "show", "root() | @", "--json"], {
        cwd: directory,
        env,
        encoding: "utf8",
        timeout: 30000
      })
      expect(ambiguous.status).not.toBe(0)
      expect(ambiguous.stdout + ambiguous.stderr).toContain("Expected exactly one revision")
      expect(invoke(["change", "list", "--limit", "1"])[0].description).toBe("CLI change")
      expect(invoke(["change", "files", "@"]).files).toEqual(["hello.txt"])
      expect(invoke(["change", "conflicts", "@"]).conflicts).toEqual([])
      expect(invoke(["bookmark", "create", "cli-test"]).name).toBe("cli-test")
      expect(invoke(["bookmark", "list"])[0].target_change_id).toBe(status.working_copy.change_id)
      expect(invoke(["bookmark", "delete", "cli-test"]).status).toBe("deleted")
      expect(invoke(["bookmark", "list"])).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120000)
  it("reports conflicted paths, not copied ones, as change conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "one-cli-jj-conflicts-"))
    const env = childEnvironment({
      ...process.env,
      JJ_USER: "CLI test",
      JJ_EMAIL: "cli@example.test",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
    })
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { cwd: directory, env, encoding: "utf8", timeout: 30000 })
    const conflicts = (rev: string) =>
      JSON.parse(run(process.execPath, [cli, "change", "conflicts", rev, "--json"])).conflicts
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n") + "\n"
    try {
      run("jj", ["git", "init"])
      await writeFile(join(directory, "shared.txt"), lines)
      run("jj", ["commit", "-m", "base"])
      run("jj", ["bookmark", "create", "base", "-r", "@-"])
      await writeFile(join(directory, "shared.txt"), "left\n")
      run("jj", ["commit", "-m", "left"])
      run("jj", ["bookmark", "create", "left", "-r", "@-"])
      run("jj", ["new", "base"])
      await writeFile(join(directory, "copy.txt"), lines)
      await writeFile(join(directory, "shared.txt"), lines + "right\n")
      run("jj", ["commit", "-m", "right"])
      run("jj", ["bookmark", "create", "right", "-r", "@-"])
      expect(run("jj", ["diff", "--summary", "-r", "right"])).toContain("C {shared.txt => copy.txt}")
      expect(conflicts("right")).toEqual([])
      run("jj", ["new", "left", "right", "-m", "merge"])
      expect(conflicts("@")).toEqual(["shared.txt"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120000)
})
