/**
 * A job whose step runs `ping` is left out of a replay on a machine whose jail takes away the rights `ping` asks for.
 *
 * On many Linux machines `/usr/bin/ping` asks for `cap_net_raw` through a file capability. A replay runs every step
 * with no new privileges, in bubblewrap and under the recorder, so there `ping` gets nothing and fails, where on a
 * runner it passes. `smthrs ci` names the program in its results (`TargetResult.rights`), and the replay leaves the
 * job out as one that fails on this machine.
 *
 * The real program replays real repositories, with this machine's `ping`, jail and tracer.
 */
import { spawnSync } from "node:child_process"
import { afterAll, describe, expect, it } from "vitest"
import { failsHere } from "../../src/contract/Inventory.vibe"
import type { ReplayCommit, ReplayReport, RunTotals } from "../../src/contract/ReplayReport.vibe"
import { text } from "../../src/report/Text.vibe"
import { bin, commit, git, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const pinging = ["-c1", "-W2", "127.0.0.1"]
const confined = spawnSync("setpriv", ["--no-new-privs", "ping", ...pinging], { stdio: "ignore" })
/** A machine whose `ping` passes when run plainly and fails with no new privileges: its rights come from its file. */
const asksForRights = spawnSync("ping", pinging, { stdio: "ignore" }).status === 0 &&
  confined.error === undefined && confined.status !== 0

const reason = "runs `ping`, which needs rights this machine's jail takes away"
const ping = "ping -c1 -W2 127.0.0.1 > /dev/null && grep -qx ok data/ping.txt"
const pingskip =
  "if ping -c1 -W2 127.0.0.1 > /dev/null 2>&1; then grep -qx ok data/pingskip.txt; else echo 'no ICMP here: skipped'; fi"
const plain = "grep -qx ok data/plain.txt"

/** A workflow of one job for each entry of `jobs`, each running its commands, one step each. */
const workflowOf = (jobs: Readonly<Record<string, ReadonlyArray<string>>>): string =>
  [
    "name: CI",
    "on: [push]",
    "jobs:",
    ...Object.entries(jobs).flatMap(([id, commands]) => [
      `  ${id}:`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      ...commands.map((command) => `      - run: ${JSON.stringify(command)}`)
    ]),
    ""
  ].join("\n")

const workflowFile = ".github/workflows/ci.yml"

/** Three commits: every data file `ok`, a change to the docs alone, every data file `bad`. */
const repository = (prefix: string): { readonly root: string; readonly commits: ReadonlyArray<string> } => {
  const root = temporary(prefix)
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  const data = (value: string) => ({
    "data/ping.txt": `${value}\n`,
    "data/pingskip.txt": `${value}\n`,
    "data/plain.txt": `${value}\n`
  })
  commit(root, "base", {
    [workflowFile]: workflowOf({ ping: [ping], pingskip: [pingskip], plain: [plain] }),
    ...data("ok"),
    "docs/readme.md": "# Fixture\n"
  })
  commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
  commit(root, "bad data", data("bad"))
  return { root, commits: git(root, "rev-list", "--reverse", "HEAD").trim().split("\n") }
}

const counted = (totals: RunTotals): number =>
  totals.counts.hit + totals.counts.ran + totals.counts.failed + totals.counts.skipped

const ways = (
  replayed: ReplayCommit
): ReadonlyArray<RunTotals> => [
  replayed.baseline,
  replayed.normal,
  ...(replayed.fast === undefined ? [] : [replayed.fast])
]

const failedSteps = (totals: RunTotals): ReadonlyArray<string> => (totals.failures ?? []).map((failure) => failure.step)

/** What a report says of `plain` and of nothing else, at every commit and in every way: it fails at the bad data. */
const onlyPlain = (report: ReplayReport): void => {
  expect(report.mismatches).toBe(0)
  for (const [index, replayed] of report.commits.entries()) {
    const bad = index === report.commits.length - 1
    for (const way of ways(replayed)) {
      expect(counted(way), JSON.stringify(way)).toBe(1)
      expect(failedSteps(way)).toEqual(bad ? ["ci.yml:plain:1"] : [])
    }
  }
}

describe.skipIf(!asksForRights)("a job whose step runs ping, which asks for rights", () => {
  it("is left out from the first commit with no trial, which runs again without it", async () => {
    const { root, commits } = repository("rights-no-trial")
    // Three commits and no commit before them: no way runs first, and the first counted commit finds it.
    const outcome = await spawn(bin, ["--commits", "3", "--no-trial", "--no-apply-check", "--json"], root)
    expect(outcome.code, outcome.stderr).toBe(0)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.notReplayed).toEqual([
      { job: "ci.yml:ping", reasons: [{ feature: failsHere, detail: reason }] },
      { job: "ci.yml:pingskip", reasons: [{ feature: failsHere, detail: reason }] }
    ])
    expect(report.jobs).toEqual({ replayed: 1, total: 3 })
    expect(report.commits.map((replayed) => replayed.commit)).toEqual(commits)
    onlyPlain(report)
    expect(outcome.stderr).toContain(`1/3 ${commits[0]!.slice(0, 7)} again without ci.yml:ping, ci.yml:pingskip`)
    // The text report says the same of both.
    const printed = text(report)
    expect(printed).toMatch(
      /ci\.yml:ping +fails on this machine: runs `ping`, which needs rights this machine's jail takes away\n/
    )
    expect(printed).toMatch(/ci\.yml:pingskip +fails on this machine: runs `ping`, which needs rights/)
  }, 540_000)

  it(
    "is left out before any commit counts with the trial, where the run before the first commit finds it",
    async () => {
      const { root } = repository("rights-trial")
      const outcome = await spawn(bin, ["--commits", "2", "--no-apply-check", "--json"], root)
      expect(outcome.code, outcome.stderr).toBe(0)
      const report = JSON.parse(outcome.stdout) as ReplayReport
      // The trial runs the baseline alone, which names no program: there `ping` fails as any step does, and is left
      // out with its error. The step that skips its check passes there, and the first run of normal mode finds it.
      expect(report.notReplayed?.map((entry) => entry.job)).toEqual(["ci.yml:ping", "ci.yml:pingskip"])
      expect(report.notReplayed?.[0]?.reasons[0]?.feature).toBe(failsHere)
      expect(report.notReplayed?.[1]?.reasons).toEqual([{ feature: failsHere, detail: reason }])
      expect(report.commits).toHaveLength(2)
      onlyPlain(report)
      expect(outcome.stderr).not.toContain(" again without ")
    },
    540_000
  )

  it(
    "is left out from the commit that adds the ping step, which runs again; the commits before keep the job",
    async () => {
      const root = temporary("rights-later")
      made.push(root)
      git(root, "init", "--quiet", "--initial-branch=main")
      const before = workflowOf({ net: [plain], plain: [plain] })
      commit(root, "base", { [workflowFile]: before, "data/plain.txt": "ok\n", "data/ping.txt": "ok\n" })
      commit(root, "docs", { "docs/readme.md": "# Fixture\n" })
      commit(root, "ping", { [workflowFile]: workflowOf({ net: [plain, ping], plain: [plain] }) })
      const commits = git(root, "rev-list", "--reverse", "HEAD").trim().split("\n")
      const outcome = await spawn(bin, ["--commits", "3", "--no-trial", "--no-apply-check", "--json"], root)
      expect(outcome.code, outcome.stderr).toBe(0)
      const report = JSON.parse(outcome.stdout) as ReplayReport
      expect(report.notReplayed).toEqual([{ job: "ci.yml:net", reasons: [{ feature: failsHere, detail: reason }] }])
      expect(report.mismatches).toBe(0)
      const [first, second, third] = report.commits
      // `net` and `plain` at the first two commits; `plain` alone at the third, which ran again without `net`.
      for (const replayed of [first!, second!]) {
        for (const way of ways(replayed)) expect([counted(way), way.ok]).toEqual([2, true])
      }
      for (const way of ways(third!)) expect([counted(way), way.ok]).toEqual([1, true])
      const at = `3/3 ${commits[2]!.slice(0, 7)}`
      expect(outcome.stderr).toContain(`${at} again without ci.yml:net`)
      expect(outcome.stderr.split("\n").filter((line) => line.endsWith(`${at} baseline`))).toHaveLength(2)
    },
    540_000
  )
})
