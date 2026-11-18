/** The real program on real repositories whose CI fails here. */
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { exitCodes } from "../../src/contract/Command.ts"
import { commit, git, temporary } from "../native/repo.ts"
import { bin, head, spawn } from "./repo.ts"

const made: Array<string> = []
afterAll(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true })
})

const missing = "smithers-ci-test-no-such-program"

const workflow = (...commands: ReadonlyArray<string>): string =>
  [
    "on: push",
    "jobs:",
    ...commands.flatMap((command, index) => [
      `  job${index}:`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - run: ${command}`
    ]),
    ""
  ].join("\n")

/** A repository whose commits each hold the given files, oldest first. */
const repositoryOf = (...commits: ReadonlyArray<Readonly<Record<string, string>>>): string => {
  const root = temporary("failed-steps")
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  commits.forEach((files, index) => commit(root, `commit ${index}`, files))
  return root
}

describe("smithers-ci on a repository where one job cannot pass here", { timeout: 600_000 }, () => {
  const file = ".github/workflows/ci.yml"
  const failing = "echo no docker here >&2; exit 1"

  it("measures the jobs that pass, lists the other with its error, and exits 0", async () => {
    const root = repositoryOf({ [file]: workflow("sh check.sh", failing), "check.sh": "exit 0\n" }, {
      "note.txt": "x\n"
    })
    const outcome = await spawn(bin, ["--commits", "2"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toMatch(/× (faster|slower) over 1 of 2 jobs\n/)
    expect(outcome.stdout).toContain("2 commits · 1 of 2 jobs · 0 mismatches · 1 job not replayed")
    expect(outcome.stdout).toContain("found the jobs that pass on this machine in ")
    expect(outcome.stdout).toMatch(/ci\.yml:job1 +fails on this machine: no docker here\n/)
  })

  it("exits 3 when no job passes", async () => {
    const root = repositoryOf({ [file]: workflow(failing) })
    const outcome = await spawn(bin, ["--commits", "1"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.unsupported)
    expect(outcome.stdout).toBe("")
    expect(outcome.stderr).toContain(`No job passed at ${head(root).slice(0, 7)}.`)
    expect(outcome.stderr).toContain("  error    no docker here\n")
  })

  it("with --no-trial runs every job, and the failing job fails each commit", async () => {
    const root = repositoryOf({ [file]: workflow("sh check.sh", failing), "check.sh": "exit 0\n" })
    const outcome = await spawn(bin, ["--commits", "1", "--no-trial"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toContain("no speedup: the CI failed at every replayed commit")
    expect(outcome.stdout).not.toContain("fails on this machine")
  })

  it("stops a step that makes no progress at the limit --stall-minutes sets", async () => {
    const blocked = "d=$(mktemp -d); mkfifo $d/pipe; cat $d/pipe"
    const root = repositoryOf({ [file]: workflow("sh check.sh", blocked), "check.sh": "exit 0\n" })
    const outcome = await spawn(bin, ["--commits", "1", "--stall-minutes", "0.1"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toMatch(/ci\.yml:job1 +fails on this machine: it made no progress for 0\.1 minutes\n/)
  })

  it("refuses a stall limit that is not above 0", async () => {
    const root = repositoryOf({ [file]: workflow("sh check.sh"), "check.sh": "exit 0\n" })
    const outcome = await spawn(bin, ["--stall-minutes", "0"], root)
    expect(outcome.code).toBe(exitCodes.usage)
    expect(outcome.stderr).toContain("a number of minutes above 0")
  })
})

describe("smithers-ci on a repository whose CI fails here", { timeout: 600_000 }, () => {
  it("exits 3 with the first failure and no speedup when no step ever passes", async () => {
    const file = ".github/workflows/ci.yml"
    const root = repositoryOf({ [file]: workflow(`${missing} --version`) }, { "note.txt": "a change\n" })
    const outcome = await spawn(bin, ["--commits", "2"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.unsupported)
    expect(outcome.stdout).toBe("")
    expect(outcome.stderr).not.toContain("faster")
    expect(outcome.stderr).toContain("this repository's CI does not pass on this machine")
    expect(outcome.stderr).toContain(`First failure at ${head(root).slice(0, 7)}:`)
    expect(outcome.stderr).toContain(`  command  ${missing} --version\n`)
    expect(outcome.stderr).toContain("  exit     127\n")
    expect(outcome.stderr).toContain(`  error    \`${missing}\` is not installed on this machine\n`)
  })

  it("reports the failing commit with its reason, and the speedup over the others", async () => {
    const file = ".github/workflows/ci.yml"
    const root = repositoryOf(
      { [file]: workflow("sh check.sh"), "check.sh": "exit 0\n" },
      { "check.sh": "echo 'the check broke' >&2\nexit 7\n" },
      { "check.sh": "exit 0\n" }
    )
    const outcome = await spawn(bin, ["--commits", "3"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toMatch(/× (faster|slower) over 2 of 3 commits\n/)
    expect(outcome.stdout).toMatch(/failed steps\n\w{7} {2}baseline, normal {2}\S+ {2}exit 7: the check broke\n/)
    const json = await spawn(bin, ["--commits", "3", "--json"], root)
    const report = JSON.parse(json.stdout) as {
      readonly speedupCommits: number
      readonly commits: ReadonlyArray<{ readonly baseline: { readonly failures?: ReadonlyArray<unknown> } }>
    }
    expect(report.speedupCommits).toBe(2)
    expect(report.commits[1]?.baseline.failures).toEqual([
      expect.objectContaining({ reason: "the check broke", exitCode: 7, command: "sh check.sh" })
    ])
  })
})
