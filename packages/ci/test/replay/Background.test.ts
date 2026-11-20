/**
 * A step that leaves a program running. On GitHub the runner stops such a program when the job ends ("Cleaning up
 * orphan processes"). In a replay the jail gives each step a process namespace of its own, so the program ends with
 * its step, in the baseline and as a target, and nothing of it is left when the replay is over.
 */

import { spawnSync } from "node:child_process"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { probe } from "../../src/replay/Jail.ts"
import { bin, commit, git, remove, spawn, temporary } from "../cli/repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const runner = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"

/**
 * The programs of this user whose whole command line is `sleep <seconds>`, by process id. `pgrep` names only those:
 * a listing of every process grew past what a test reads on a build host running many jails, and how many
 * processes a host runs is no part of this test. It exits 1 when none matches.
 */
const sleeping = (seconds: number): ReadonlyArray<string> => {
  const found = spawnSync("pgrep", ["-u", String(process.getuid?.()), "-x", "-f", `sleep ${seconds}`], {
    encoding: "utf8"
  })
  if (found.status !== 0 && found.status !== 1) throw new Error(`pgrep failed: ${found.stderr}`)
  return found.stdout.split("\n").filter((line) => line !== "")
}

describe.runIf(!("refusal" in probe()))("a step that leaves a program running", () => {
  it("passes alike both ways and leaves nothing behind when the replay ends", async () => {
    const seconds = 90_000 + (process.pid % 9_000)
    const root = temporary("replay-background")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", {
      ".github/workflows/ci.yml": `
on: push
jobs:
  build:
    runs-on: ${runner}
    steps:
      - uses: actions/checkout@v4
      - run: nohup sleep ${seconds} > /dev/null 2>&1 &
      - run: cat src.txt
`,
      "src.txt": "one\n"
    })

    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check", "--json", "--no-trial"], root)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.commits[0]?.baseline.ok).toBe(true)
    expect(report.commits[0]?.normal.ok).toBe(true)
    expect(report.commits[0]?.mismatches).toEqual([])
    expect(outcome.code).toBe(0)
    expect(sleeping(seconds)).toEqual([])
  }, 900_000)
})
