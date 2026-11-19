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

  it("measures the jobs that pass, names the share, lists the other with its step, exit code and error", async () => {
    const jobs = workflow("sh check.sh", "sh check.sh", failing)
    const root = repositoryOf({ [file]: jobs, "check.sh": "exit 0\n" }, { "note.txt": "x\n" })
    const outcome = await spawn(bin, ["--commits", "2", "--no-apply-check"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    // The headline says how much of the CI the number covers.
    expect(outcome.stdout).toMatch(/× (faster|slower) over 2 of 3 jobs\n/)
    expect(outcome.stdout).toContain("2 commits · 2 of 3 jobs · 0 mismatches · 1 job not replayed")
    expect(outcome.stdout).toContain("found the jobs that pass on this machine in ")
    expect(outcome.stdout).toMatch(
      /ci\.yml:job2 +fails on this machine: \S.*: exit 1: no docker here \(at \w{7} and \w{7}\)\n/
    )
    const json = await spawn(bin, ["--commits", "2", "--no-apply-check", "--json"], root)
    const report = JSON.parse(json.stdout) as {
      readonly jobs: unknown
      readonly notReplayed: ReadonlyArray<{
        readonly job: string
        readonly reasons: ReadonlyArray<{ readonly detail: string }>
      }>
    }
    expect(report.jobs).toEqual({ replayed: 2, total: 3 })
    expect(report.notReplayed.map((entry) => entry.job)).toEqual(["ci.yml:job2"])
    expect(report.notReplayed[0]?.reasons[0]?.detail).toMatch(/: exit 1: no docker here \(at \w{7} and \w{7}\)$/)
  })

  it("does not measure a CI of which half the jobs cannot pass here: it lists them with why, and exits 3", async () => {
    const root = repositoryOf({ [file]: workflow("sh check.sh", failing), "check.sh": "exit 0\n" })
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.unsupported)
    expect(outcome.stdout).toBe("")
    expect(outcome.stderr).toContain(
      "this replay cannot measure your CI on this machine: 1 of its 2 jobs does not pass here"
    )
    expect(outcome.stderr).toMatch(
      /\n {2}ci\.yml:job1 {2}fails on this machine: \S.*: exit 1: no docker here \(at \w{7}\)\n/
    )
    expect(outcome.stderr).toContain("pass --no-trial to compare every job as it is.")
    expect(outcome.stderr).not.toMatch(/faster|slower/)
  })

  it("exits 3 when no job passes", async () => {
    const root = repositoryOf({ [file]: workflow(failing) })
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.unsupported)
    expect(outcome.stdout).toBe("")
    expect(outcome.stderr).toContain(`No job passed at ${head(root).slice(0, 7)}.`)
    expect(outcome.stderr).toContain("  error    no docker here\n")
  })

  it("with --no-trial runs every job, and the failing job fails each commit", async () => {
    const root = repositoryOf({ [file]: workflow("sh check.sh", failing), "check.sh": "exit 0\n" })
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check", "--no-trial"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toContain("no speedup: the CI failed at every replayed commit")
    expect(outcome.stdout).not.toContain("fails on this machine")
  })

  it("stops a step that makes no progress at the limit --stall-minutes sets", async () => {
    const blocked = "d=$(mktemp -d); mkfifo $d/pipe; cat $d/pipe"
    const jobs = workflow("sh check.sh", "sh check.sh", blocked)
    const root = repositoryOf({ [file]: jobs, "check.sh": "exit 0\n" })
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check", "--stall-minutes", "0.1"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toMatch(
      /ci\.yml:job2 +fails on this machine: \S.*: it made no progress for 0\.1 minutes \(at \w{7}\)\n/
    )
  })

  it("refuses a stall limit that is not above 0", async () => {
    const root = repositoryOf({ [file]: workflow("sh check.sh"), "check.sh": "exit 0\n" })
    const outcome = await spawn(bin, ["--stall-minutes", "0"], root)
    expect(outcome.code).toBe(exitCodes.usage)
    expect(outcome.stderr).toContain("a number of minutes above 0")
  })
})

describe("smithers-ci on a repository where normal mode gives another result than the CI", { timeout: 600_000 }, () => {
  // The script passes as the baseline runs it, and fails as a target: a job is at the same paths both ways, so it
  // looks for the `smthrs ci` that started it among the processes above it.
  const fresh = [
    "p=$$",
    "while [ \"${p:-0}\" -gt 1 ]; do",
    "  case \"$(ps -o args= -p \"$p\")\" in *--results-file*) echo 'not a fresh clone' >&2; exit 5;; esac",
    "  p=$(ps -o ppid= -p \"$p\" | tr -d ' ')",
    "done",
    ""
  ].join("\n")

  it("prints the mismatches and what to do, and no speedup, as text and as JSON", async () => {
    const file = ".github/workflows/ci.yml"
    const root = repositoryOf({ [file]: workflow("sh fresh.sh"), "fresh.sh": fresh }, { "note.txt": "x\n" })
    const outcome = await spawn(bin, ["--commits", "2", "--no-apply-check", "--no-trial"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.mismatch)
    const lines = outcome.stdout.split("\n")
    expect(lines[0]).toMatch(/^✗ \d+ mismatch(es)?$/)
    expect(lines[2]).toBe(
      "no speedup: normal mode gave another result than your CI, so its time measures nothing. Each mismatch is listed below with its commit; fix what it names, or report it, and run this again."
    )
    expect(outcome.stdout).not.toMatch(/× (faster|slower)/)
    expect(outcome.stdout).toMatch(/^\w{7} {2}normal {2}\S+ {2}pass → fail$/m)
    const json = await spawn(bin, ["--commits", "2", "--no-apply-check", "--no-trial", "--json"], root)
    expect(json.code, json.stderr).toBe(exitCodes.mismatch)
    const report = JSON.parse(json.stdout) as Record<string, number>
    expect(report["mismatches"]).toBeGreaterThan(0)
    expect(report).toMatchObject({ speedup: 0, speedupCommits: 0, baselineWallMs: 0, normalWallMs: 0 })
  })
})

describe("smithers-ci on a job whose middle step fails", { timeout: 600_000 }, () => {
  const steps = (...commands: ReadonlyArray<string>): string =>
    [
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      ...commands.map((command) => `      - run: ${command}`),
      ""
    ].join("\n")

  it("gives the step's own error as the reason, in the baseline and in normal mode, on one line", async () => {
    const file = ".github/workflows/ci.yml"
    const root = repositoryOf({
      [file]: steps("sh check.sh", "echo 'the middle starts'; echo 'the middle failed' >&2; exit 7", "sh check.sh"),
      "check.sh": "exit 0\n"
    })
    const json = await spawn(bin, ["--commits", "1", "--no-apply-check", "--no-trial", "--json"], root)
    const report = JSON.parse(json.stdout) as {
      readonly commits: ReadonlyArray<Record<"baseline" | "normal", { readonly failures?: ReadonlyArray<unknown> }>>
    }
    const failure = expect.objectContaining({ reason: "the middle failed", exitCode: 7 })
    expect(report.commits[0]?.baseline.failures).toEqual([failure])
    // Not the first line of what stands around the step in the generated build file.
    expect(report.commits[0]?.normal.failures).toEqual([failure])
  })

  it("lists a step that wrote no error output once, though each way reads its reason from another line", async () => {
    const file = ".github/workflows/ci.yml"
    const root = repositoryOf({
      [file]: steps("sh check.sh", "echo 'one'; echo 'two failed'; exit 6", "sh check.sh"),
      "check.sh": "exit 0\n"
    })
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check", "--no-trial"], root)
    const listed = outcome.stdout.split("\n").filter((line) => line.includes("exit 6"))
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatch(/^\w{7} {2}baseline, normal {2}\S.* {2}exit 6: two failed$/)
  })
})

describe("smithers-ci on a step that fails and prints nothing", { timeout: 600_000 }, () => {
  const file = ".github/workflows/ci.yml"
  interface Failure {
    readonly step: string
    readonly reason: string
    readonly exitCode?: number
  }
  type Report = {
    readonly commits: ReadonlyArray<Record<"baseline" | "normal", { readonly failures?: ReadonlyArray<Failure> }>>
  }
  const failuresOf = async (root: string): Promise<Record<"baseline" | "normal", ReadonlyArray<Failure>>> => {
    const json = await spawn(bin, ["--commits", "1", "--no-apply-check", "--no-trial", "--json"], root)
    expect(json.stdout, json.stderr).not.toBe("")
    const commit = (JSON.parse(json.stdout) as Report).commits[0]
    return { baseline: commit?.baseline.failures ?? [], normal: commit?.normal.failures ?? [] }
  }
  const job = (name: string, ...steps: ReadonlyArray<string>): ReadonlyArray<string> => [
    `  ${name}:`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...steps.map((step) => `      - ${step}`)
  ]
  const nothing = (step: string, exitCode: number) =>
    expect.objectContaining({ step, reason: "it printed nothing", exitCode })

  it("says so in the baseline and in normal mode, for a last step, a middle step and a step under a limit", async () => {
    const jobs = [
      "on: push",
      "jobs:",
      ...job("last", "run: exit 3"),
      ...job("middle", "run: sh check.sh", "run: exit 4", "run: sh check.sh"),
      ...job("limited", "run: exit 5\n        timeout-minutes: 5"),
      ...job("passes", "run: sh check.sh"),
      ""
    ].join("\n")
    const root = repositoryOf({ [file]: jobs, "check.sh": "exit 0\n" })
    const expected = [nothing("ci.yml:last:1", 3), nothing("ci.yml:middle:2", 4), nothing("ci.yml:limited:1", 5)]
    const failures = await failuresOf(root)
    expect(failures.baseline).toEqual(expected)
    // Not a line of the text that stands around the step in the generated build file.
    expect(failures.normal).toEqual(expected)
  })

  it("says so for jobs that run apart, whose build text starts with a line of its own", async () => {
    // Two versions of a tool: each job's steps run on a runner of their own.
    const node = (version: number) => `uses: actions/setup-node@v4\n        with:\n          node-version: ${version}`
    const jobs = [
      "on: push",
      "jobs:",
      ...job("older", node(20), "run: exit 3"),
      ...job("newer", node(22), "run: exit 4"),
      ...job("says", node(22), "run: echo building; echo 'the widget failed' >&2; exit 2"),
      ...job("passes", node(22), "run: sh check.sh"),
      ""
    ].join("\n")
    const root = repositoryOf({ [file]: jobs, "check.sh": "exit 0\n" })
    const expected = [
      nothing("ci.yml:older:1", 3),
      nothing("ci.yml:newer:1", 4),
      expect.objectContaining({ step: "ci.yml:says:1", reason: "the widget failed", exitCode: 2 })
    ]
    const failures = await failuresOf(root)
    expect(failures.baseline).toEqual(expected)
    expect(failures.normal).toEqual(expected)
  })

  it("says so for a step a signal ended: the shell around the step adds no line of its own", async () => {
    const jobs = [
      "on: push",
      "jobs:",
      ...job("killed", "run: kill -KILL $$"),
      ...job("ended", "run: kill -TERM $$\n        timeout-minutes: 5"),
      ...job("crashed", "run: echo 'the widget failed' >&2; kill -SEGV $$"),
      ...job("passes", "run: sh check.sh"),
      ""
    ].join("\n")
    const root = repositoryOf({ [file]: jobs, "check.sh": "exit 0\n" })
    const expected = [
      nothing("ci.yml:killed:1", 137),
      nothing("ci.yml:ended:1", 143),
      expect.objectContaining({ step: "ci.yml:crashed:1", reason: "the widget failed", exitCode: 139 })
    ]
    const failures = await failuresOf(root)
    expect(failures.baseline).toEqual(expected)
    expect(failures.normal).toEqual(expected)
  })

  it("gives each of many failed steps its own line, the first to fail as the last", async () => {
    // Each job prints more than a replay once kept of a whole run, and then what failed.
    const noisy = [
      "i=0",
      "while [ $i -lt 700 ]; do",
      "  echo \"line $i of job $1, which is of no use to the person who reads why the job failed\" >&2",
      "  i=$((i + 1))",
      "done",
      "echo \"error: job $1 broke\" >&2",
      "exit 1",
      ""
    ].join("\n")
    const count = 6
    const jobs = [
      "on: push",
      "jobs:",
      ...Array.from({ length: count }, (_, n) => job(`job${n}`, `run: sh noisy.sh ${n}`)).flat(),
      ...job("passes", "run: sh check.sh"),
      ""
    ].join("\n")
    const root = repositoryOf({ [file]: jobs, "noisy.sh": noisy, "check.sh": "exit 0\n" })
    const expected = Array.from(
      { length: count },
      (_, n) => expect.objectContaining({ step: `ci.yml:job${n}:1`, reason: `error: job ${n} broke`, exitCode: 1 })
    )
    const failures = await failuresOf(root)
    expect(failures.baseline).toEqual(expected)
    expect(failures.normal).toEqual(expected)
  })
})

describe("smithers-ci on a repository whose CI fails here", { timeout: 600_000 }, () => {
  it("exits 3 with the first failure and no speedup when no step ever passes", async () => {
    const file = ".github/workflows/ci.yml"
    const root = repositoryOf({ [file]: workflow(`${missing} --version`) }, { "note.txt": "a change\n" })
    const outcome = await spawn(bin, ["--commits", "2", "--no-apply-check"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.unsupported)
    expect(outcome.stdout).toBe("")
    expect(outcome.stderr).not.toContain("faster")
    expect(outcome.stderr).toContain("this repository's CI does not pass on this machine")
    // The first run is at the oldest commit, and what failed there ran once more at the newest.
    const oldest = git(root, "rev-parse", "HEAD^").trim().slice(0, 7)
    expect(outcome.stderr).toContain(`No job passed at ${oldest} or at ${head(root).slice(0, 7)}.`)
    expect(outcome.stderr).toContain(`First failure at ${oldest}:`)
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
    const outcome = await spawn(bin, ["--commits", "3", "--no-apply-check"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toMatch(/× (faster|slower) over 2 of 3 commits\n/)
    expect(outcome.stdout).toMatch(/failed steps\n\w{7} {2}baseline, normal {2}\S+ {2}exit 7: the check broke\n/)
    const json = await spawn(bin, ["--commits", "3", "--no-apply-check", "--json"], root)
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
