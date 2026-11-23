/**
 * A step that makes a name where its commit holds nothing fails at the
 * commit that puts something there, in the replay and in the CI `apply`
 * writes.
 *
 * `mkdir out` passes where nothing is and fails where the commit holds `out`.
 * The step read nothing at `out`: it made it. Records held no name a step
 * made, so normal mode and the generated workflow reused the step's pass at
 * the commit that added the name, and nothing reported it. A step's own
 * leftover, which git does not track, is no change: a commit that changes
 * only the docs reuses every step.
 *
 * The real program replays the repository, and the real `smthrs` runs the
 * generated workflow's command as a runner does, under each recorder this
 * machine has.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { compiledCode } from "../../src/generate/Render.ts"
import { probe } from "../../src/replay/Jail.ts"
import { bin, commit, git, head, observes, remove, spawnWith } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const smthrs = fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))
const supervisor = fileURLToPath(
  new URL(`../../../smithers/build/build-cli/native/out/linux-${process.arch}/smthrs-observe`, import.meta.url)
)

/** A machine that can give a step a `/tmp` of its own: Linux with a bubblewrap that starts. */
const mounts = !("refusal" in probe())

/** The recorders this machine has, each as the variable that picks it. */
const recorders = [
  ...(process.platform === "linux" && process.arch === "x64" && existsSync(supervisor) ? ["smthrs-observe"] : []),
  ...(observes ? ["strace"] : [])
]

/** Each job makes one name with one call, and the commit after the docs puts something at that name. */
const jobs: ReadonlyArray<readonly [name: string, command: string]> = [
  ["mkdir", "mkdir out-mkdir"],
  ["mkdirp", "mkdir -p out-mkdirp/sub && test \"$(ls -A out-mkdirp)\" = sub"],
  ["excl", "(set -C; echo made > out-excl)"],
  ["symlink", "ln -s base.txt out-symlink"],
  ["fifo", "mkfifo out-fifo"],
  ["link", "ln base.txt out-link"]
]

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  ...jobs.flatMap(([name, command]) => [
    `  ${name}:`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    `      - run: ${JSON.stringify(command)}`
  ]),
  ""
].join("\n")

/** What the commit puts at each name: a file or a directory with a file below. A link is a file to git. */
const added: Readonly<Record<string, string>> = {
  "out-mkdir/x.txt": "committed\n",
  "out-mkdirp": "committed\n",
  "out-excl": "committed\n",
  "out-symlink": "committed\n",
  "out-fifo/x.txt": "committed\n"
}

/** The commit that puts something at every name a step makes, and a link at the last. */
const addNames = (source: string): void => {
  symlinkSync("base.txt", join(source, "out-link"))
  commit(source, "names added", added)
}

/** The repository, every file right. Beside the temporary directory, as a runner's work directory is. */
const repository = (prefix: string): { readonly base: string; readonly source: string } => {
  const base = mkdtempSync(`/var/tmp/smithers-ci-${prefix}-`)
  made.push(base)
  const source = join(base, "source")
  mkdirSync(source)
  git(source, "init", "--quiet", "--initial-branch=main")
  commit(source, "base", {
    ".github/workflows/ci.yml": workflow,
    "docs/readme.md": "# Fixture\n",
    "base.txt": "base\n"
  })
  return { base, source }
}

const failedJobs = (failures: ReadonlyArray<{ readonly step: string }> | undefined): ReadonlyArray<string> =>
  (failures ?? []).map((failure) => failure.step).sort()

describe.skipIf(recorders.length === 0)("a job that makes a name where its commit holds nothing", () => {
  for (const recorder of recorders) {
    it(
      `fails in normal mode at the commit that puts something at the name, as in the baseline, with ${recorder}`,
      async () => {
        const { source } = repository(`made-names-replay-${recorder}`)
        commit(source, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
        addNames(source)
        const outcome = await spawnWith(bin, ["--commits", "2", "--no-trial", "--no-apply-check", "--json"], source, {
          SMTHRS_OBSERVE_WITH: recorder
        })
        expect(outcome.stdout, outcome.stderr).not.toBe("")
        const report = JSON.parse(outcome.stdout) as ReplayReport
        const [docs, broken] = report.commits
        expect(report.commits).toHaveLength(2)
        expect([docs!.baseline.ok, docs!.normal.ok]).toEqual([true, true])
        // Each job made its name, which the commit before held nothing at, and the docs did not change that.
        expect(docs!.normal.counts).toMatchObject({ hit: jobs.length, ran: 0 })
        const all = jobs.map(([name]) => `ci.yml:${name}:1`).sort()
        expect(failedJobs(broken!.baseline.failures)).toEqual(all)
        expect(failedJobs(broken!.normal.failures)).toEqual(all)
        expect(report.commits.flatMap((replayed) => replayed.mismatches)).toEqual([])
        expect(report.mismatches).toBe(0)
      },
      540_000
    )

    it(`fails in the CI \`apply\` writes, on a runner that restored the run before, with ${recorder}`, async () => {
      const { base, source } = repository(`made-names-applied-${recorder}`)
      const applied = spawnSync(process.execPath, [bin, "apply"], { cwd: source, encoding: "utf8" })
      expect(applied.status, applied.stderr).toBe(0)
      commit(source, "apply")
      const before = head(source)
      addNames(source)
      const after = head(source)
      const state = join(base, "state", "smithers-ci")
      const run = (sha: string, attempt: number, fresh = true) => {
        // A fresh clone at the same path and an empty home, with the variables a runner sets.
        const checkout = join(base, "run")
        const home = join(base, "home")
        if (fresh) {
          remove(checkout)
          remove(home)
          mkdirSync(home)
          git(base, "clone", "--quiet", source, checkout)
          git(checkout, "checkout", "--quiet", "-B", "main", sha)
        }
        const results = join(base, `results-${attempt}.json`)
        const ran = spawnSync(
          process.execPath,
          [smthrs, "ci", "//...", "--ui", "plain", "--results-file", results, "--cache-dir", state],
          {
            cwd: checkout,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            env: {
              ...process.env,
              HOME: home,
              CI: "true",
              GITHUB_ACTIONS: "true",
              GITHUB_SHA: sha,
              GITHUB_REF: "refs/heads/main",
              GITHUB_EVENT_NAME: "push",
              GITHUB_RUN_ID: String(7_000 + attempt),
              GITHUB_RUN_NUMBER: String(attempt),
              GITHUB_RUN_ATTEMPT: "1",
              GITHUB_REPOSITORY: "example/made-names",
              GITHUB_WORKSPACE: checkout,
              RUNNER_TEMP: join(base, "runner-temp"),
              RUNNER_OS: "Linux",
              NODE_COMPILE_CACHE: join(state, compiledCode),
              SMTHRS_OBSERVE_WITH: recorder,
              ...(mounts ? { SMTHRS_MACHINE_OWN_TMP: "required" } : {})
            }
          }
        )
        const record = JSON.parse(readFileSync(results, "utf8")) as {
          readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
        }
        return {
          code: ran.status,
          statuses: Object.fromEntries(record.results.map((result) => [result.label, result.status])),
          printed: `${ran.stdout}${ran.stderr}`
        }
      }
      const labels = jobs.map(([name]) => `//:ci.yml-${name}-1`)
      const first = run(before, 1)
      expect([first.code, first.statuses], first.printed).toEqual([
        0,
        Object.fromEntries(labels.map((label) => [label, "ran"]))
      ])
      // Again in the same checkout, which holds what the first run left: what a step left is its own.
      const again = run(before, 2, false)
      expect([again.code, again.statuses], again.printed).toEqual([
        0,
        Object.fromEntries(labels.map((label) => [label, "hit"]))
      ])
      // The next run restores what the first stored. The commit put something at every name a step made: each runs
      // and fails.
      const second = run(after, 3)
      expect(second.statuses, second.printed).toEqual(Object.fromEntries(labels.map((label) => [label, "failed"])))
      expect(second.code).not.toBe(0)
    }, 540_000)
  }
})
