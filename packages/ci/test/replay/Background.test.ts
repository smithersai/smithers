/**
 * A step that leaves a program running. On GitHub the program lives until the job ends, so a later step can use it,
 * and the runner stops it then ("Cleaning up orphan processes"). A replay keeps it as long, in the baseline and in
 * normal mode, where the machine can hold a job's processes in a namespace of their own, and nothing of it is left
 * when the replay is over.
 */

import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { reaperProgram } from "../../src/replay/Environment.ts"
import { probe } from "../../src/replay/Jail.ts"
import { bin, commit, git, remove, spawn, spawnWith, temporary } from "../cli/repo.ts"

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
  it("keeps it for the step after it both ways, and leaves nothing behind when the replay ends", async () => {
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
      - name: Start it
        run: nohup sleep ${seconds} > /dev/null 2>&1 &
      - run: pgrep -x -f 'sleep ${seconds}' > /dev/null && cat src.txt
`,
      "src.txt": "one\n"
    })

    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check", "--json", "--no-trial"], root)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.notReplayed ?? []).toEqual([])
    expect(report.commits[0]?.baseline.ok).toBe(true)
    expect(report.commits[0]?.normal.ok).toBe(true)
    expect(report.commits[0]?.mismatches).toEqual([])
    expect(outcome.code).toBe(0)
    expect(sleeping(seconds)).toEqual([])
  }, 900_000)
})

describe.runIf(process.platform === "linux" && reaperProgram() !== undefined)(
  "a step that leaves a program running where nothing can keep it",
  () => {
    it("ends the program with its step, however it detached, in the baseline and in normal mode", async () => {
      const seconds = 93_000 + (process.pid % 900)
      const root = temporary("replay-reaped")
      const tools = temporary("replay-reaped-tools")
      made.push(root, tools)
      // A bubblewrap that cannot start anything: every step runs with no jail and no namespace of its job.
      writeFileSync(join(tools, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      git(root, "init", "--quiet", "--initial-branch=main")
      commit(root, "base", {
        ".github/workflows/ci.yml": `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sh start.sh
      - run: cat src.txt
`,
        // A session of its own, which the step's text does not show: nothing ends it but the program it runs under.
        "start.sh": `setsid -f sleep ${seconds} > /dev/null 2>&1 < /dev/null\n`,
        "src.txt": "one\n"
      })
      const outcome = await spawnWith(bin, ["--commits", "1", "--no-apply-check", "--json", "--no-trial"], root, {
        PATH: `${tools}:${process.env["PATH"]}`
      })
      expect(outcome.code, outcome.stderr).toBe(0)
      const report = JSON.parse(outcome.stdout) as ReplayReport
      expect(report.notReplayed ?? []).toEqual([])
      expect(report.commits[0]?.baseline.ok).toBe(true)
      expect(report.commits[0]?.normal.ok).toBe(true)
      expect(sleeping(seconds)).toEqual([])
    }, 900_000)
  }
)
