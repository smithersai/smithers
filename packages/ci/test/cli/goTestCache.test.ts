/**
 * A Go test's result never outlives the job that made it.
 *
 * `go` keeps the result of a test in its cache and answers `ok (cached)`
 * until a file the test process itself opened changes. The test of this
 * repository reads its file through `cat`, which `go` does not see. On a
 * runner every job starts with an empty home, so `go` finds no result and
 * tests. The fourth ship review's blocker 2: Smithers build started every
 * step with `GOCACHE` in its own cache directory, which a replay keeps
 * between commits and the generated workflow carries between runs, and the
 * step passed a commit the repository's CI fails.
 *
 * The real program replays the repository, and the real `smthrs` runs the
 * generated workflow's command as a runner does, with this machine's `go`
 * and tracer.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { compiledCode } from "../../src/generate/Render.ts"
import { probe } from "../../src/replay/Jail.ts"
import { bin, commit, git, head, observes, remove, spawn } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const smthrs = fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))

/** A machine with `go`, which the job's one step starts. */
const hasGo = spawnSync("go", ["version"]).status === 0

/** A machine that can give a step a `/tmp` of its own: Linux with a bubblewrap that starts. */
const mounts = !("refusal" in probe())

/** A workflow whose one job runs `commands`, one step each. */
const workflowOf = (commands: ReadonlyArray<string>): string =>
  [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...commands.map((command) => `      - run: ${command}`),
    ""
  ].join("\n")

const test = [
  "package x",
  "",
  "import (",
  "\t\"os/exec\"",
  "\t\"strings\"",
  "\t\"testing\"",
  ")",
  "",
  "func TestValue(t *testing.T) {",
  "\tout, err := exec.Command(\"cat\", \"testdata/value.txt\").Output()",
  "\tif err != nil {",
  "\t\tt.Fatal(err)",
  "\t}",
  "\tif strings.TrimSpace(string(out)) != \"ok\" {",
  "\t\tt.Fatalf(\"value is %q\", out)",
  "\t}",
  "}",
  ""
].join("\n")

const step = "//:ci.yml-test-1"

/** Where a tool was once told to keep a cache in the directory the workflow carries. */
const ofATool: ReadonlyArray<string> = ["go-build", "tools"]

/** The repository, with the value right: a job of one step, `go test ./...`, unless `commands` names its steps. */
const repository = (
  prefix: string,
  commands: ReadonlyArray<string> = ["go test ./..."]
): { readonly base: string; readonly source: string } => {
  // Beside the temporary directory, as a runner's work directory and home are.
  const base = mkdtempSync(`/var/tmp/smithers-ci-${prefix}-`)
  made.push(base)
  const source = join(base, "source")
  mkdirSync(source)
  git(source, "init", "--quiet", "--initial-branch=main")
  commit(source, "base", {
    ".github/workflows/ci.yml": workflowOf(commands),
    "go.mod": "module example.test/stale\n\ngo 1.22\n",
    "x.go": "package x\n",
    "x_test.go": test,
    "testdata/value.txt": "ok\n",
    "docs/readme.md": "# Fixture\n"
  })
  return { base, source }
}

/** Every file under `root`, from it. */
const filesUnder = (root: string): ReadonlyArray<string> =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort()

/** A file of `go`'s cache: an action or an output entry in its shard, or anything under a `go-build`. */
const ofGoCache = (name: string): boolean =>
  /(?:^|\/)[0-9a-f]{2}\/[0-9a-f]{64}-[ad]$/.test(name) || name.split("/").includes("go-build")

/**
 * The workflow `apply` wrote for the repository at `source`, as a runner runs it: `run` is one run at a commit,
 * with how it ended, each step's status by its label, and what it printed. `state` is the directory the workflow
 * carries from one run to the next.
 */
const runner = (base: string, source: string) => {
  const state = join(base, "state", "smithers-ci")
  let runs = 0
  const run = (sha: string) => {
    // A fresh clone at the same path and an empty home, with the variables a runner sets.
    const checkout = join(base, "run")
    const home = join(base, "home")
    remove(checkout)
    remove(home)
    mkdirSync(home)
    git(base, "clone", "--quiet", source, checkout)
    git(checkout, "checkout", "--quiet", "-B", "main", sha)
    runs += 1
    // A run that fails prints why and no list of steps: the list is read from the file the run writes.
    const results = join(base, `results-${runs}.json`)
    const command = [smthrs, "ci", "//...", "--ui", "plain", "--results-file", results, "--cache-dir", state]
    const ran = spawnSync(process.execPath, command, {
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
        GITHUB_REF_NAME: "main",
        GITHUB_EVENT_NAME: "push",
        GITHUB_RUN_ID: String(9_000 + runs),
        GITHUB_RUN_NUMBER: String(runs),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REPOSITORY: "example/go-stale",
        GITHUB_WORKSPACE: checkout,
        RUNNER_TEMP: join(base, "runner-temp"),
        RUNNER_OS: "Linux",
        NODE_COMPILE_CACHE: join(state, compiledCode),
        ...(mounts ? { SMTHRS_MACHINE_OWN_TMP: "required" } : {})
      }
    })
    const record = JSON.parse(readFileSync(results, "utf8")) as {
      readonly recorder?: { readonly name: string }
      readonly results: ReadonlyArray<{
        readonly label: string
        readonly status: string
        readonly notReused?: string
        readonly notStored?: string
      }>
    }
    return {
      code: ran.status,
      statuses: Object.fromEntries(record.results.map((result) => [result.label, result.status])),
      cache: {
        recorder: record.recorder?.name,
        reasons: record.results.map(({ label, status, notReused, notStored }) => ({
          label,
          status,
          notReused,
          notStored
        }))
      },
      printed: `${ran.stdout}${ran.stderr}`
    }
  }
  return { state, run }
}

describe.skipIf(!hasGo)("a Go test that reads a file through a child process", () => {
  it("fails in normal mode at the commit that breaks the file, as in the baseline", async () => {
    const { source } = repository("go-stale-replay")
    commit(source, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
    commit(source, "value broken", { "testdata/value.txt": "bad\n" })
    const outcome = await spawn(bin, ["--commits", "2", "--no-trial", "--no-apply-check", "--json"], source)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    // Oldest first: the commit that changes a file no step reads, then the one that breaks the value.
    const [docs, broken] = report.commits
    expect(report.commits).toHaveLength(2)
    expect([docs!.baseline.ok, docs!.normal.ok]).toEqual([true, true])
    // Both ways ran `go test`, and it tested: the result of the commit before answered neither.
    expect((broken!.baseline.failures ?? []).map((failure) => failure.step)).toEqual(["ci.yml:test:1"])
    expect((broken!.normal.failures ?? []).map((failure) => failure.step)).toEqual(["ci.yml:test:1"])
    expect(JSON.stringify(report)).not.toContain("(cached)")
    expect(report.mismatches).toBe(0)
    expect(report.commits.flatMap((replayed) => replayed.mismatches)).toEqual([])
    // Where the machine records what a step reads, the step was reused at the commit that changes none of them.
    if (observes) {
      expect(
        docs!.normal.counts,
        JSON.stringify(
          docs!.normal.notReused?.map(({ step, reason, kept }) => ({
            step,
            reason,
            kept
          }))
        )
      ).toMatchObject({ hit: 1, ran: 0 })
    }
  }, 540_000)

  it("fails in the CI `apply` writes, on a runner that restored the cache of the run before", async () => {
    const { base, source } = repository("go-stale-applied")
    const applied = await spawn(bin, ["apply"], source)
    expect(applied.code, applied.stderr).toBe(0)
    commit(source, "apply")
    const before = head(source)
    commit(source, "value broken", { "testdata/value.txt": "bad\n" })
    const after = head(source)

    const { state, run } = runner(base, source)

    const first = run(before)
    expect([first.code, first.statuses], first.printed).toEqual([0, { [step]: "ran" }])
    // The directory the workflow carries holds Smithers build's own files: its records and its compiled code. No
    // tool was told to keep a cache there, and no step of the job comes after this one, so what it left in its
    // home is kept for nobody: nothing of `go`'s lies in the directory, loose or in an archive.
    const carried = filesUnder(state)
    expect(carried.filter((name) => name.startsWith("cache/")).length, JSON.stringify(first.cache)).toBeGreaterThan(0)
    expect(carried.filter((name) => ofGoCache(name))).toEqual([])
    expect(carried.filter((name) => name.endsWith(".tar"))).toEqual([])
    const top = [...new Set(carried.map((name) => name.split("/")[0] as string))]
    expect(top).toEqual(expect.arrayContaining(["cache", compiledCode]))
    expect(top.filter((name) => ofATool.includes(name))).toEqual([])
    // The next run restores that directory. Its step reads the changed file, so it runs, and `go` tests.
    const second = run(after)
    expect(second.statuses, second.printed).toEqual({ [step]: "failed" })
    expect(second.code).not.toBe(0)
    expect(second.printed).toContain("value is")
    expect(second.printed).not.toContain("(cached)")
  }, 540_000)
  it(
    "puts back what a reused step left in its home for the step after it, and carries nothing of the last",
    async () => {
      // Two steps in one job: the first compiles, the second tests. Only the test reads the value.
      // The second step starts only where the first has left `go`'s cache in the job's home, as it has on a runner.
      const { base, source } = repository("go-stale-two", [
        "go vet ./...",
        "test -f ~/.cache/go-build/README && go test ./..."
      ])
      const applied = await spawn(bin, ["apply"], source)
      expect(applied.code, applied.stderr).toBe(0)
      commit(source, "apply")
      const before = head(source)
      commit(source, "value broken", { "testdata/value.txt": "bad\n" })
      const after = head(source)
      const { state, run } = runner(base, source)
      const vet = "//:ci.yml-test-1"
      const tests = "//:ci.yml-test-2"

      const first = run(before)
      expect([first.code, first.statuses], first.printed).toEqual([0, { [vet]: "ran", [tests]: "ran" }])
      // The test step comes after the vet step, so what the vet step left is carried: one archive of the job's
      // home, which holds what `go` compiled for it. Nothing comes after the test step: nothing of it is carried,
      // and no archive holds a result of a test.
      const archives = filesUnder(state).filter((name) => name.endsWith(".tar"))
      const ofHome = archives.filter((name) => name.endsWith(".machine.tar"))
      expect(ofHome).toHaveLength(1)
      const listed = spawnSync("tar", ["-tf", join(state, ofHome[0]!)], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
      })
      expect(listed.status, listed.stderr).toBe(0)
      expect(listed.stdout.split("\n").filter((name) => name.includes(".cache/go-build/")).length).toBeGreaterThan(0)
      expect(statSync(join(state, ofHome[0]!)).size).toBeGreaterThan(1024 * 1024)
      // The next run restores the directory. The vet step read nothing that changed and is reused. The job's new
      // home is empty until its files are put back: the test step finds `go`'s cache there, so it starts, and
      // `go` tests, and the test fails on the value.
      const second = run(after)
      expect(second.statuses, JSON.stringify([first.cache, second.cache])).toEqual({ [vet]: "hit", [tests]: "failed" })
      expect(second.code).not.toBe(0)
      expect(second.printed).toContain("value is")
      expect(second.printed).not.toContain("(cached)")
      // Still nothing of the last step is carried.
      expect(filesUnder(state).filter((name) => name.endsWith(".machine.tar"))).toHaveLength(1)
    },
    540_000
  )
})
