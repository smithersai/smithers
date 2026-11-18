/**
 * The real `smithers-ci` replays commits of a real repository whose job keeps a directory with `actions/cache`.
 * From the third commit on the job fails unless the cache step restored what an earlier commit's run saved, in
 * the baseline and as targets alike. The job is never left out as failing here: it is judged at the first commit
 * the replay runs, and the commits after it restore what that run saved.
 */

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
