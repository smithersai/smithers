/**
 * A pull request that changes the repository's shape fails the generated
 * workflow until `apply` runs again: a real repository, the published
 * executable, and the workflow's own commands as a runner runs them.
 */

import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { exitCodes } from "../../src/contract/Command.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { workflowPath } from "../../src/generate/Render.ts"
import { bin, commit, git, head, remove, repository, spawn, temporary, workspace } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const release: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version

/** Each program the workflow installs with `npx`, as this checkout has it. */
const programs: Readonly<Record<string, string>> = {
  "smithers-ci@smithers-ci": bin,
  "@smthrs/cli@smthrs": fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))
}

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly if?: string
  readonly run?: string
  readonly env?: Readonly<Record<string, string>>
}

/**
 * The commands of the workflow in `root`, in order. A step with an `if:` prepares a GitHub runner (it installs
 * what this machine already has, or prints a notice) and runs only where GitHub evaluates its condition.
 */
const commandsOf = (root: string): ReadonlyArray<{ readonly run: string; readonly env: Record<string, string> }> => {
  const steps = (parseYaml(readFileSync(join(root, workflowPath), "utf8")) as {
    readonly jobs: { readonly ci: { readonly steps: ReadonlyArray<Step> } }
  }).jobs.ci.steps
  return steps.flatMap((step) => {
    if (step.run === undefined || step.if !== undefined) return []
    // Only the program differs: this checkout's for the published release the workflow names.
    const installed = /^npx --yes --package=(\S+)@(\S+) (\S+) /.exec(step.run)
    expect(installed, step.run).not.toBeNull()
    const [whole, name, version, program] = installed as unknown as [string, string, string, string]
    expect(version).toBe(release)
    const entry = programs[`${name}@${program}`]
    expect(entry, whole).toBeDefined()
    // A value GitHub fills from the repository's settings is empty: this repository sets none.
    const env = Object.fromEntries(
      Object.entries(step.env ?? {}).map(([key, value]) => [key, value.includes("${{") ? "" : value])
    )
    return [{ run: `"$NODE" "${entry}" ${step.run.slice(whole.length)}`, env }]
  })
}

/** Runs the commands in order, as a runner does: the first that fails ends the job. */
const runJob = (root: string, commands: ReturnType<typeof commandsOf>) => {
  const ran: Array<{ readonly code: number | null; readonly output: string }> = []
  for (const command of commands) {
    const result = spawnSync("bash", ["-c", command.run], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...command.env, NODE: process.execPath },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000
    })
    ran.push({ code: result.status, output: `${result.stdout}${result.stderr}` })
    if (result.status !== 0) break
  }
  return ran
}

const apply = async (root: string): Promise<void> => {
  const applied = await spawn(bin, ["apply"], root)
  expect(applied.code, applied.stderr).toBe(exitCodes.ok)
}

/** A package whose test fails, printing a line this test looks for. */
const failing = {
  "packages/c/package.json": JSON.stringify({
    name: "c",
    scripts: { test: "node -e \"console.error('c fails here'); process.exit(3)\"" }
  })
}

describe("a pull request that adds a package", () => {
  it(
    "fails the generated workflow's first command, naming the file and the command, until apply runs again",
    async () => {
      const root = workspace()
      made.push(root)
      await apply(root)
      commit(root, "apply")
      commit(root, "a package with a failing test", failing)

      const commands = commandsOf(root)
      expect(commands[0]?.run).toContain(" apply --check")
      const stale = runJob(root, commands)
      expect(stale).toHaveLength(1)
      expect(stale[0]?.code).toBe(exitCodes.mismatch)
      expect(stale[0]?.output).toContain(".smithers/WORKSPACE.smithers is out of date: run smithers-ci apply\n")
      // What the check stops: the targets written before the package existed never run its test, and pass.
      const unchecked = runJob(root, commands.slice(1))
      expect(unchecked.map((ran) => ran.code), unchecked.at(-1)?.output).toEqual(commands.slice(1).map(() => 0))
      expect(unchecked.map((ran) => ran.output).join("")).not.toMatch(/test-1-c|c fails here/)

      await apply(root)
      commit(root, "apply again")
      const fresh = runJob(root, commandsOf(root))
      expect(fresh.map((ran) => ran.code)).toEqual([...commandsOf(root).slice(0, -1).map(() => 0), 1])
      expect(fresh[0]?.output).toBe("smithers-ci: the generated files are up to date\n")
      // The new package's test runs and fails.
      expect(fresh.at(-1)?.output).toMatch(/\/\/:ci\.yml-test-1-c +failed/)
    },
    900_000
  )
})

describe("the same commit elsewhere", () => {
  it("checks clean in a fresh clone at another path, as a runner's checkout is", async () => {
    const root = repository(["first"])
    made.push(root)
    git(root, "remote", "add", "origin", "https://github.com/acme/widget.git")
    await apply(root)
    commit(root, "apply")
    const elsewhere = temporary("checkout")
    made.push(elsewhere)
    const clone = join(elsewhere, "work", "widget")
    git(elsewhere, "clone", "--quiet", "--no-local", root, clone)
    git(clone, "remote", "set-url", "origin", "https://github.com/acme/widget.git")
    expect(await spawn(bin, ["apply", "--check"], clone)).toEqual({
      code: exitCodes.ok,
      stdout: "smithers-ci: the generated files are up to date\n",
      stderr: ""
    })
  }, 300_000)
})

describe("a replayed commit that adds a package", () => {
  it("runs that package's failing test in normal mode, though the newest commit has no such package", async () => {
    const root = workspace()
    made.push(root)
    commit(root, "a package with a failing test", failing)
    const added = head(root)
    // The newest commit removes the package: targets made once, from the newest commit, would never run its test.
    git(root, "rm", "--quiet", "-r", "packages/c")
    git(root, "commit", "--quiet", "--message", "remove it")
    const outcome = await spawn(bin, ["replay", "--commits", "2", "--json"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    const report = Schema.decodeUnknownSync(ReplayReport)(JSON.parse(outcome.stdout))
    const byCommit = new Map(report.commits.map((replayed) => [replayed.commit, replayed]))
    const failed = byCommit.get(added)
    expect(failed?.normal.ok, outcome.stdout).toBe(false)
    // The step's targets were made from that commit's own tree, so the new package's test ran, and failed.
    expect(failed?.normal.failures).toEqual([
      { step: "ci.yml:test:1", reason: "c fails here", exitCode: 3, command: "npm run test --workspaces --if-present" }
    ])
    // The baseline failed the same way, so it is no mismatch.
    expect(failed?.baseline.ok).toBe(false)
    expect(failed?.mismatches).toEqual([])
    expect(byCommit.get(head(root))?.normal.ok).toBe(true)
    expect(report.mismatches).toBe(0)
  }, 900_000)
})
