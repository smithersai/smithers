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
