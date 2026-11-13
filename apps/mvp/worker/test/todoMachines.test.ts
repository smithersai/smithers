import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as TodoMachine from "../flows/TodoMachine.ts"
import { machines } from "./todoMachines.ts"

const branch = (attemptId = "attempt-one", checkout: string) =>
  TodoMachine.machineOf({ attemptId, repoId: "github/owner/repo", checkout, ownerId: "person" }).branch

describe("the TODO test machine", () => {
  test.each([
    ["exit 23", 23, "", ""],
    ["this_executable_does_not_exist", 127, "", "not found"],
    ["printf output; printf problem >&2; exit 7", 7, "output", "problem"],
  ] as const)("executes %s through the direct tool and command jobs", async (command, exitCode, stdout, stderr) => {
    const github = scriptedGitHub()
    const machine = machines(github)
    const checkout = branch("attempt-one", github.refs.get("main")!)
    const direct = await Effect.runPromise(machine.service.tool(checkout, "person", "direct", { tool: "run", command }))
    const jobs = machine.service.commands(checkout, "person")
    await Effect.runPromise(jobs.start({ tool: "run", command }, "job"))
    await expect.poll(() => Effect.runPromise(jobs.observe("job")), { timeout: 10_000 }).toMatchObject({ state: "finished" })
    const collected = await Effect.runPromise(jobs.collect("job"))
    expect.soft(direct.result).toMatchObject({ tool: "run", exitCode, stdout })
    expect.soft(direct.result.tool === "run" && direct.result.stderr).toContain(stderr)
    expect(collected).toMatchObject({ tool: "run", exitCode, stdout })
    expect(collected.stderr).toContain(stderr)
  })

  test("files, checks, status and diff share one checkout, isolated by attempt and pinned to its base", async () => {
    const github = scriptedGitHub()
    const base = github.push("main", {
      "README.md": "base\n",
      ".smithers/checks/readme.sh": "test \"$(cat README.md)\" = changed\n",
    })
    github.push("main", { "README.md": "newer\n" })
    const machine = machines(github)
    const first = branch("attempt-one", base)
    const other = branch("attempt-two", base)
    const tool = (callId: string, call: Parameters<typeof machine.service.tool>[3]) =>
      Effect.runPromise(machine.service.tool(first, "person", callId, call))
    expect((await tool("initial", { tool: "read", path: "README.md" })).result).toMatchObject({ content: "base\n" })
    expect((await tool("failing-check", { tool: "run", command: "sh .smithers/checks/readme.sh" })).result)
      .toMatchObject({ tool: "run", exitCode: 1 })
    await tool("write", { tool: "write", path: "README.md", content: "changed\n" })
    const jobs = machine.service.commands(first, "person")
    await Effect.runPromise(jobs.start({ tool: "run", command: "sh .smithers/checks/readme.sh && printf checked > check.txt" }, "check"))
    await expect.poll(() => Effect.runPromise(jobs.observe("check")), { timeout: 10_000 }).toMatchObject({ state: "finished", exitCode: 0 })
    expect((await tool("read-check", { tool: "read", path: "check.txt" })).result).toMatchObject({ content: "checked" })
    expect((await tool("status", { tool: "status" })).result).toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ path: "README.md", worktree: "M" })]),
    })
    const diff = (await tool("diff", { tool: "diff" })).result
    expect(diff.tool === "diff" && diff.diff).toContain("-base")
    expect(diff.tool === "diff" && diff.diff).toContain("+changed")
    expect((await Effect.runPromise(machine.service.tool(other, "person", "other", { tool: "read", path: "README.md" }))).result)
      .toMatchObject({ content: "base\n" })
    // The same owner and key on a different attempt has its own command fence and result.
    const otherJobs = machine.service.commands(other, "person")
    await Effect.runPromise(otherJobs.start({ tool: "run", command: "printf other > check.txt" }, "check"))
    await expect.poll(() => Effect.runPromise(otherJobs.observe("check")), { timeout: 10_000 })
      .toMatchObject({ state: "finished", exitCode: 0 })
    expect((await Effect.runPromise(machine.service.tool(other, "person", "read-other", { tool: "read", path: "check.txt" }))).result)
      .toMatchObject({ content: "other" })
    // A repeated job key executes only once, including its write into the same checkout.
    await Effect.runPromise(jobs.start({ tool: "run", command: "printf duplicate >> check.txt" }, "check"))
    expect((await tool("read-again", { tool: "read", path: "check.txt" })).result).toMatchObject({ content: "checked" })
  })
  test("compares published provider commits without changing the checkout or its index", async () => {
    const github = scriptedGitHub()
    const base = github.push("main", { "README.md": "base\n" })
    const machine = machines(github, undefined, { checkout: () => base })
    const checkout = { ...branch("published-attempt", base), branch: "try-1" }
    const tool = (call: Parameters<typeof machine.service.tool>[3]) =>
      Effect.runPromise(machine.service.tool(checkout, "person", crypto.randomUUID(), call))
    await tool({ tool: "write", path: "README.md", content: "changed\n" })
    const published = github.push("published", { "README.md": "changed\n" })
    expect((await tool({ tool: "status", base: published })).result).toMatchObject({ entries: [] })
    expect((await tool({ tool: "read", path: "README.md" })).result).toMatchObject({ content: "changed\n" })
    expect((await tool({ tool: "status" })).result).toMatchObject({
      entries: [{ path: "README.md", index: " ", worktree: "M" }],
    })
    const newer = github.push("published", { "README.md": "upstream\n" })
    expect((await tool({ tool: "status", base: newer })).result).toMatchObject({
      entries: [{ path: "README.md", index: "M", worktree: " " }],
    })
    expect((await tool({ tool: "read", path: "README.md" })).result).toMatchObject({ content: "changed\n" })
  })

  test("provider snapshot files remain tracked even when their own gitignore ignores them", async () => {
    const github = scriptedGitHub()
    const base = github.push("main", { ".gitignore": "kept.txt\n", "kept.txt": "base\n" })
    const machine = machines(github)
    const checkout = branch("ignored-tracked-attempt", base)
    const tool = (call: Parameters<typeof machine.service.tool>[3]) =>
      Effect.runPromise(machine.service.tool(checkout, "person", crypto.randomUUID(), call))
    await tool({ tool: "write", path: "kept.txt", content: "changed\n" })
    expect((await tool({ tool: "status" })).result).toMatchObject({
      entries: [{ path: "kept.txt", index: " ", worktree: "M" }],
    })
    const published = github.push("published", { "kept.txt": "changed\n" })
    expect((await tool({ tool: "status", base: published })).result).toMatchObject({ entries: [] })
    const diff = (await tool({ tool: "diff" })).result
    expect(diff.tool === "diff" && diff.diff).toContain("-base")
    expect(diff.tool === "diff" && diff.diff).toContain("+changed")
  })

  test("teardown cancels a running detached command before removing its checkout", async () => {
    const github = scriptedGitHub()
    const machine = machines(github)
    const checkout = branch("running-attempt", github.refs.get("main")!)
    const jobs = machine.service.commands(checkout, "person")
    await Effect.runPromise(jobs.start({ tool: "run", command: 'printf "%s" "$$" > command.pid; sleep 120' }, "running"))
    const workdir = machine.copies.get(checkout.branchId)!.workdir
    await expect.poll(() => existsSync(join(workdir, "command.pid"))).toBe(true)
    const pid = readFileSync(join(workdir, "command.pid"), "utf8")
    expect(await Effect.runPromise(jobs.observe("running"))).toMatchObject({ state: "running" })
    await machine.close()
    expect(existsSync(workdir)).toBe(false)
    const active = () => {
      try {
        // A zombie has exited and cannot execute; the OS's parent may not have reaped it yet.
        return !execFileSync("ps", ["-p", pid, "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          .trim().startsWith("Z")
      } catch { return false }
    }
    await expect.poll(active, { timeout: 10_000 }).toBe(false)
    await machine.close()
  })
})
