/**
 * A step that reads a repository file through `/proc/self` fails at the
 * commit that breaks the file, in the replay and in the CI `apply` writes.
 *
 * `grep -qx ok /proc/self/cwd/data/x` reads `data/x`. The fifth ship review's
 * blocker 3: the recorders left every path under `/proc` out of the record,
 * so normal mode and the generated workflow reused the step's pass after the
 * file changed, and nothing reported it.
 *
 * The real program replays the repository, and the real `smthrs` runs the
 * generated workflow's command as a runner does, under each recorder this
 * machine has.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
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

/** Each job reads its own file of `data` through one link of its process. */
const jobs: ReadonlyArray<readonly [name: string, command: string]> = [
  ["procfd", "exec 3<data; grep -qx ok /proc/self/fd/3/procfd.txt"],
  ["procroot", "grep -qx ok \"/proc/self/root$PWD/data/procroot.txt\""],
  ["proccwd", "grep -qx ok /proc/self/cwd/data/proccwd.txt"]
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

/** Every data file holding `value`, which keeps its size: `ok` or `no`. */
const data = (value: string): Readonly<Record<string, string>> =>
  Object.fromEntries(jobs.map(([name]) => [`data/${name}.txt`, `${value}\n`]))

/** The repository, every file right. Beside the temporary directory, as a runner's work directory is. */
const repository = (prefix: string): { readonly base: string; readonly source: string } => {
  const base = mkdtempSync(`/var/tmp/smithers-ci-${prefix}-`)
  made.push(base)
  const source = join(base, "source")
  mkdirSync(source)
  git(source, "init", "--quiet", "--initial-branch=main")
  commit(source, "base", { ".github/workflows/ci.yml": workflow, "docs/readme.md": "# Fixture\n", ...data("ok") })
  return { base, source }
}

const failedJobs = (failures: ReadonlyArray<{ readonly step: string }> | undefined): ReadonlyArray<string> =>
  (failures ?? []).map((failure) => failure.step).sort()

describe.skipIf(recorders.length === 0)("a job that reads a file through /proc/self", () => {
  for (const recorder of recorders) {
    it(`fails in normal mode at the commit that breaks the file, as in the baseline, with ${recorder}`, async () => {
      const { source } = repository(`proc-links-replay-${recorder}`)
      commit(source, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
      commit(source, "data broken", data("no"))
      const outcome = await spawnWith(bin, ["--commits", "2", "--no-trial", "--no-apply-check", "--json"], source, {
        SMTHRS_OBSERVE_WITH: recorder
      })
      expect(outcome.stdout, outcome.stderr).not.toBe("")
      const report = JSON.parse(outcome.stdout) as ReplayReport
      const [docs, broken] = report.commits
      expect(report.commits).toHaveLength(2)
      expect([docs!.baseline.ok, docs!.normal.ok]).toEqual([true, true])
      // Each job read its file, so each was answered from the commit before only while the file was the same.
      expect(docs!.normal.counts).toMatchObject({ hit: 3, ran: 0 })
      const all = ["ci.yml:proccwd:1", "ci.yml:procfd:1", "ci.yml:procroot:1"]
      expect(failedJobs(broken!.baseline.failures)).toEqual(all)
      expect(failedJobs(broken!.normal.failures)).toEqual(all)
      expect(report.commits.flatMap((replayed) => replayed.mismatches)).toEqual([])
      expect(report.mismatches).toBe(0)
    }, 540_000)

    it(`fails in the CI \`apply\` writes, on a runner that restored the run before, with ${recorder}`, async () => {
      const { base, source } = repository(`proc-links-applied-${recorder}`)
      const applied = spawnSync(process.execPath, [bin, "apply"], { cwd: source, encoding: "utf8" })
      expect(applied.status, applied.stderr).toBe(0)
      commit(source, "apply")
      const before = head(source)
      commit(source, "data broken", data("no"))
      const after = head(source)
      const state = join(base, "state", "smithers-ci")
      const run = (sha: string, attempt: number) => {
        // A fresh clone at the same path and an empty home, with the variables a runner sets.
        const checkout = join(base, "run")
        const home = join(base, "home")
        remove(checkout)
        remove(home)
        mkdirSync(home)
        git(base, "clone", "--quiet", source, checkout)
        git(checkout, "checkout", "--quiet", "-B", "main", sha)
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
              GITHUB_REPOSITORY: "example/proc-links",
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
      // The next run restores what the first stored. Every step read its file, which changed: each runs and fails.
      const second = run(after, 2)
      expect(second.statuses, second.printed).toEqual(Object.fromEntries(labels.map((label) => [label, "failed"])))
      expect(second.code).not.toBe(0)
    }, 540_000)
  }
})
