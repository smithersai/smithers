/**
 * A job is a machine, end to end.
 *
 * On GitHub every job of this workflow passes at every commit, because each
 * starts on a runner of its own: a fresh checkout, an empty home, and nothing
 * another job did. The real program replays the repository both ways, and
 * the real `smthrs` runs the CI that `apply` writes, on this one machine.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { stateDirectory } from "../../src/generate/Render.ts"
import { probe } from "../../src/replay/Jail.ts"
import { bin, commit, git, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

const smthrs = fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))

const job = (name: string, ...runs: ReadonlyArray<string>): ReadonlyArray<string> => [
  `  ${name}:`,
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  ...runs.map((run) => `      - run: ${JSON.stringify(run)}`)
]

/** The second ship review's blockers 2 and 4, with a job whose steps rely on one another. */
const workflow = [
  "name: CI",
  "on: [push, pull_request]",
  "jobs:",
  // One job changes a file that another job checks, and leaves a file a third job expects not to find.
  ...job("mutate", "echo bad > s/shared"),
  ...job("pristine", "grep -q ok s/shared"),
  ...job("flagwrite", "touch leftover.flag"),
  ...job("flagabsent", "test ! -e leftover.flag"),
  // The shape of `mkdir ~/x` with no `-p`: each job expects a home nothing wrote to.
  ...job("homea", "test ! -e ~/.adv-seen && touch ~/.adv-seen"),
  ...job("homeb", "test ! -e ~/.adv-seen && touch ~/.adv-seen # b"),
  // The steps of one job share its checkout and its home, in order.
  ...job("steps", "echo built > out.txt && echo tool > ~/.tool", "grep -q built out.txt && grep -q tool ~/.tool"),
  // What a job's steps pass on through GITHUB_ENV is kept in a directory that holds no other job's: its own two
  // entries, for what its first step left and for the job.
  ...job(
    "state",
    "echo PASSED=on >> \"$GITHUB_ENV\"",
    "test \"$PASSED\" = on && test \"$(ls \"$(dirname \"$(dirname \"$RUNNER_TEMP\")\")\" | wc -l)\" -le 2"
  ),
  ""
].join("\n")

const jobs = ["mutate", "pristine", "flagwrite", "flagabsent", "homea", "homeb", "steps", "state"]

const repository = (): string => {
  const root = keep(temporary("job-machine"))
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "base", {
    ".github/workflows/ci.yml": workflow,
    ".gitignore": "out.txt\n",
    "docs/readme.md": "# Fixture\n",
    "s/shared": "ok\n"
  })
  commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
  return root
}

describe("a workflow whose jobs pass only on machines of their own", () => {
  it("is replayed with no failure and no mismatch, in the baseline and in normal mode", async () => {
    const root = repository()
    const outcome = await spawn(bin, ["--commits", "2", "--no-apply-check", "--json"], root)
    expect(outcome.code, outcome.stderr).toBe(0)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.commits).toHaveLength(2)
    for (const replayed of report.commits) {
      expect([replayed.baseline.failures ?? [], replayed.normal.failures ?? []]).toEqual([[], []])
      expect(replayed.baseline.counts).toEqual({ hit: 0, ran: 10, failed: 0, skipped: 0 })
      expect(replayed.normal.counts.failed + replayed.normal.counts.skipped).toBe(0)
      expect(replayed.normal.counts.hit + replayed.normal.counts.ran).toBe(10)
      expect(replayed.mismatches).toEqual([])
    }
    expect(report.mismatches).toBe(0)
    expect((report.notReplayed ?? []).filter((left) => jobs.some((name) => left.job.includes(name)))).toEqual([])
  }, 540_000)

  it("passes as the CI `apply` writes, run on one machine, and leaves the repository as it was", async () => {
    const root = repository()
    const home = keep(temporary("job-machine-home"))
    const applied = await spawn(bin, ["apply"], root)
    expect(applied.code, applied.stderr).toBe(0)
    commit(root, "apply")
    // The command of the generated workflow, with the `smthrs` of this checkout in place of the published one.
    const generated = readFileSync(join(root, ".github/workflows/smithers-ci.yml"), "utf8")
    const steps = (parseYaml(generated) as {
      readonly jobs: { readonly ci: { readonly steps: ReadonlyArray<{ readonly run?: string }> } }
    }).jobs.ci.steps
    const command = /smthrs ci (.*)$/.exec(String(steps.find((one) => String(one.run).includes("smthrs ci"))?.run))?.[1]
    // The workflow keeps the cache in a directory of the runner's, outside the checkout.
    expect(command).toBe(`'//...' --jobs 1 --cache-dir "${stateDirectory}"`)
    const state = join(keep(temporary("job-machine-state")), "smithers-ci")
    const run = () =>
      spawnSync(process.execPath, [smthrs, "ci", "//...", "--jobs", "1", "--cache-dir", state], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, HOME: home }
      })
    const first = run()
    expect(first.status, `${first.stdout}${first.stderr}`).toBe(0)
    // No job reached the repository: the file is as committed and the flag was never left there.
    expect(readFileSync(join(root, "s/shared"), "utf8")).toBe("ok\n")
    expect(existsSync(join(root, "leftover.flag"))).toBe(false)
    expect(existsSync(join(root, "out.txt"))).toBe(false)
    expect(git(root, "status", "--porcelain")).toBe("")
    // A second run starts as the first did, so it passes too.
    const second = run()
    expect(second.status, `${second.stdout}${second.stderr}`).toBe(0)
    expect(existsSync(join(home, ".adv-seen"))).toBe(false)
  }, 540_000)
})

/** A machine that can give a step a `/tmp` of its own: Linux with a bubblewrap that starts. */
const mounts = !("refusal" in probe())

/** Each job passes on a runner of its own, where `/tmp` holds nothing another job wrote. */
const temporaryWorkflow = [
  "name: CI",
  "on: [push, pull_request]",
  "jobs:",
  // The shape of `mkdir /tmp/build` with no `-p` in two jobs.
  ...job("tmpa", "test ! -e /tmp/seen && touch /tmp/seen"),
  ...job("tmpb", "test ! -e /tmp/seen && touch /tmp/seen # b"),
  // The steps of one job share its `/tmp`, in order.
  ...job("steps", "touch /tmp/first", "test -e /tmp/first && test ! -e /tmp/seen"),
  ""
].join("\n")

describe.skipIf(!mounts)("a workflow whose jobs each expect an empty /tmp", () => {
  const repositoryOf = (): string => {
    const root = keep(temporary("job-machine-tmp"))
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", { ".github/workflows/ci.yml": temporaryWorkflow, "docs/readme.md": "# Fixture\n" })
    commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
    return root
  }

  it("is replayed with no failure and no mismatch, in the baseline and in normal mode", async () => {
    const outcome = await spawn(bin, ["--commits", "2", "--no-apply-check", "--json"], repositoryOf())
    expect(outcome.code, outcome.stderr).toBe(0)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.commits).toHaveLength(2)
    for (const replayed of report.commits) {
      expect([replayed.baseline.failures ?? [], replayed.normal.failures ?? []]).toEqual([[], []])
      expect(replayed.baseline.counts).toEqual({ hit: 0, ran: 4, failed: 0, skipped: 0 })
      expect(replayed.normal.counts.failed + replayed.normal.counts.skipped).toBe(0)
      expect(replayed.normal.counts.hit + replayed.normal.counts.ran).toBe(4)
      expect(replayed.mismatches).toEqual([])
    }
    expect(report.mismatches).toBe(0)
  }, 540_000)

  it("passes as the CI `apply` writes, which lets no two jobs share a /tmp", async () => {
    const root = repositoryOf()
    const home = keep(temporary("job-machine-tmp-home"))
    const applied = await spawn(bin, ["apply"], root)
    expect(applied.code, applied.stderr).toBe(0)
    commit(root, "apply")
    const generated = readFileSync(join(root, ".github/workflows/smithers-ci.yml"), "utf8")
    // What the workflow tells Smithers build: on a Linux runner it has installed bubblewrap for the mount.
    expect(generated).toContain("SMTHRS_MACHINE_OWN_TMP: required")
    const state = join(keep(temporary("job-machine-tmp-state")), "smithers-ci")
    const run = () =>
      spawnSync(process.execPath, [smthrs, "ci", "//...", "--jobs", "1", "--cache-dir", state], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, HOME: home, SMTHRS_MACHINE_OWN_TMP: "required" }
      })
    const first = run()
    expect(first.status, `${first.stdout}${first.stderr}`).toBe(0)
    // A second run starts as the first did, so it passes too, and the repository is as it was.
    const second = run()
    expect(second.status, `${second.stdout}${second.stderr}`).toBe(0)
    expect(git(root, "status", "--porcelain")).toBe("")
  }, 540_000)
})
