/**
 * The real `smithers-ci` replays commits of a real repository whose job keeps a directory with `actions/cache`.
 * From the third commit on the job fails unless the cache step restored what an earlier commit's run saved, in
 * the baseline and as targets alike. The job is never left out as failing here: it is judged at the first commit
 * the replay runs, and the commits after it restore what that run saved.
 */

import { spawnSync } from "node:child_process"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, remove, spawn, temporary } from "../cli/repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const runner = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"

const workflow = `
on: push
jobs:
  build:
    runs-on: ${runner}
    steps:
      - uses: actions/checkout@v4
      - id: cache
        uses: actions/cache@v4
        with:
          path: .tool-cache
          key: tool-\${{ hashFiles('tool.lock') }}
      - run: sh build.sh "\${{ steps.cache.outputs.cache-hit }}"
`

// With `expect-cache` in the tree, the build passes only when the tool came out of the cache. The store is the
// replay's own: nothing of it is in the step's home.
const build = [
  "[ ! -e \"$HOME/.cache/smithers-ci\" ] || { echo 'the store is in the home' >&2; exit 1; }",
  "if [ -f expect-cache ]; then",
  "  [ \"$1\" = true ] && [ \"$(cat .tool-cache/tool)\" = built ] || { echo 'the cache was not restored' >&2; exit 1; }",
  "else",
  "  mkdir -p .tool-cache && echo built > .tool-cache/tool",
  "fi",
  "cat src.txt",
  ""
].join("\n")

/** Four commits: two where the build makes the tool, and two that pass only with the tool out of the cache. */
const repository = (): string => {
  const root = temporary("replay-cache")
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "base", {
    ".github/workflows/ci.yml": workflow,
    "build.sh": build,
    "src.txt": "one\n",
    "tool.lock": "1\n"
  })
  commit(root, "a source change", { "src.txt": "two\n" })
  commit(root, "the build takes the tool from the cache", { "expect-cache": "", "src.txt": "three\n" })
  commit(root, "another source change", { "src.txt": "four\n" })
  return root
}

/** Every commit passed in the baseline and as targets, with nothing left out. */
const passedEverywhere = (report: ReplayReport, commits: number): void => {
  expect(report.notReplayed ?? []).toEqual([])
  expect(report.commits).toHaveLength(commits)
  for (const replayed of report.commits) {
    expect(replayed.baseline.ok).toBe(true)
    expect(replayed.normal.ok).toBe(true)
    expect(replayed.mismatches).toEqual([])
    // The restoring command, the build, and the saving command.
    const { hit, ran, failed, skipped } = replayed.baseline.counts
    expect([hit + ran, failed, skipped]).toEqual([3, 0, 0])
  }
}

describe("a replay of a job that uses actions/cache", () => {
  it("restores at the first counted commit what each way's first run saved, and leaves the job in", async () => {
    // The oldest counted commit passes only with what an earlier run saved: the first run, at the commit before it.
    const outcome = await spawn(bin, ["--commits", "2", "--no-apply-check", "--json"], repository())
    expect(outcome.stderr).not.toContain("error")
    const report = JSON.parse(outcome.stdout) as ReplayReport
    passedEverywhere(report, 2)
    expect(report.firstRun?.baselineMs).toBeGreaterThan(0)
    expect(report.firstRun?.normalMs).toBeGreaterThan(0)
    expect(outcome.code).toBe(0)
  }, 900_000)

  it(
    "restores at a later commit what an earlier commit's run saved, from the repository's first commit on",
    async () => {
      // No commit comes before the first, so the job is judged there, where it needs no cache, and stays in.
      const outcome = await spawn(bin, ["--commits", "4", "--no-apply-check", "--json"], repository())
      expect(outcome.stderr).not.toContain("error")
      const report = JSON.parse(outcome.stdout) as ReplayReport
      passedEverywhere(report, 4)
      expect(report.firstRun).toBeUndefined()
      expect(report.cold).toContain("no commit comes before")
      expect(report.trialMs).toBeGreaterThan(0)
      expect(outcome.code).toBe(0)
    },
    900_000
  )
})

// The second ship review's blocker 1: pre-commit writes where it cloned each hook's repository, as a path of the
// job's home, into the directory `actions/cache` keeps. A runner gives every job the same home, so a later job finds
// the path again. The baseline gave each job a home at a new path, and pre-commit failed at every commit after the
// first: `.pre-commit-hooks.yaml is not a file`.
const keepingWorkflow = `
on: push
jobs:
  keep:
    runs-on: ${runner}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache@v4
        with:
          path: ~/.cache/tool
          key: tool-\${{ hashFiles('tool.lock') }}
      - run: sh keep.sh
`

// The first run makes a directory as a tool makes its cache: a nested repository with a dot-file, a read-only file,
// a link that leads out of the directory, an empty directory, and the directory's own path. A later run passes only
// with all of it restored as it was saved, at the path it was saved from.
const keep = [
  "set -e",
  "d=\"$HOME/.cache/tool\"",
  "list() {",
  "  cd \"$d\"",
  "  find . -mindepth 1 ! -name where ! -name listing | LC_ALL=C sort | while IFS= read -r p; do LC_ALL=C ls -ld \"$p\"; done",
  "  find . -type f ! -name where ! -name listing -exec cksum {} + | LC_ALL=C sort",
  "}",
  "if [ -f \"$d/where\" ]; then",
  "  [ \"$(cat \"$d/where\")\" = \"$d\" ] || { echo \"the cache was saved at $(cat \"$d/where\"), not at $d\" >&2; exit 1; }",
  "  (list) > \"$RUNNER_TEMP/now\"",
  "  cmp -s \"$RUNNER_TEMP/now\" \"$d/listing\" || { diff \"$d/listing\" \"$RUNNER_TEMP/now\" >&2; exit 1; }",
  "elif [ -f expect-cache ]; then",
  "  echo 'the cache was not restored' >&2; exit 1",
  "else",
  "  mkdir -p \"$d/repo\" \"$d/empty\"",
  "  git -C \"$d/repo\" init --quiet",
  "  printf 'hooks: []\\n' > \"$d/repo/.pre-commit-hooks.yaml\"",
  "  git -C \"$d/repo\" add --all",
  "  git -C \"$d/repo\" -c user.name=t -c user.email=t@example.invalid commit --quiet -m hooks",
  "  echo fixed > \"$d/read-only\" && chmod 444 \"$d/read-only\"",
  "  ln -s ../../outside \"$d/out\"",
  "  echo \"$d\" > \"$d/where\"",
  "  (list) > \"$d/listing\"",
  "fi",
  ""
].join("\n")

describe("a replay of a job whose cache names a path of the job's home", () => {
  it(
    "restores every entry where the job saved it, at every commit, both ways and with the files apply writes",
    async () => {
      const root = temporary("replay-cache-home")
      made.push(root)
      git(root, "init", "--quiet", "--initial-branch=main")
      commit(root, "base", { ".github/workflows/ci.yml": keepingWorkflow, "keep.sh": keep, "tool.lock": "1\n" })
      commit(root, "the job takes the tool from the cache", { "expect-cache": "" })
      commit(root, "a docs change", { "docs.md": "two\n" })
      const outcome = await spawn(bin, ["--commits", "3", "--json"], root)
      expect(outcome.stderr).not.toContain("error")
      const report = JSON.parse(outcome.stdout) as ReplayReport
      expect(report.notReplayed ?? []).toEqual([])
      expect(report.commits.map((replayed) => [replayed.baseline.failures ?? [], replayed.normal.failures ?? []]))
        .toEqual([[[], []], [[], []], [[], []]])
      expect(report.commits.flatMap((replayed) => replayed.mismatches)).toEqual([])
      // The newest commit ran once more with the files `apply` writes, from what normal mode saved.
      expect(report.appliedMs).toBeGreaterThan(0)
      expect(outcome.code).toBe(0)
    },
    900_000
  )
})

const uvx = spawnSync("uvx", ["--version"], { stdio: "ignore" }).status === 0

// The reviewer's case as it is. It needs `uvx` and the network: pre-commit clones its hooks from GitHub.
describe.skipIf(!uvx)("a replay of a job that caches pre-commit's hooks", () => {
  it("passes at every commit in the baseline and in normal mode", async () => {
    const root = temporary("replay-cache-pre-commit")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", {
      ".github/workflows/ci.yml": `
on: push
jobs:
  hooks:
    runs-on: ${runner}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache@v4
        with:
          path: ~/.cache/pre-commit
          key: pre-commit|\${{ hashFiles('.pre-commit-config.yaml') }}
      - run: uvx pre-commit run --all-files
`,
      ".pre-commit-config.yaml": [
        "repos:",
        "  - repo: https://github.com/pre-commit/pre-commit-hooks",
        "    rev: v5.0.0",
        "    hooks:",
        "      - id: end-of-file-fixer",
        ""
      ].join("\n"),
      "docs/r.md": "1\n"
    })
    commit(root, "docs", { "docs/r.md": "2\n" })
    commit(root, "docs again", { "docs/r.md": "3\n" })
    const outcome = await spawn(bin, ["--commits", "3", "--no-trial", "--json"], root)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.commits.map((replayed) => [replayed.baseline.failures ?? [], replayed.normal.failures ?? []]))
      .toEqual([[[], []], [[], []], [[], []]])
    expect(report.commits.flatMap((replayed) => replayed.mismatches)).toEqual([])
    expect(outcome.code).toBe(0)
  }, 900_000)
})
