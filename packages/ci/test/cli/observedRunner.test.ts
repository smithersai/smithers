/**
 * A GitHub Actions job whose steps pass values to one another, end to end.
 *
 * The real program replays five commits of a real repository with the real
 * `smthrs`, under `strace`. A step is run as a runner runs it: it is given
 * what earlier steps wrote to `GITHUB_ENV`, and that is something it read. So
 * its result is reused while the files it opened and the values it was given
 * are the same, and it runs again when either changes. A step that names the
 * commit runs at every commit.
 */
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, observes, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const workflow = [
  "name: CI",
  "on:",
  "  push:",
  "    branches: [main]",
  "  pull_request:",
  "jobs:",
  // The check never opens version.txt: the step before it does, and passes what it holds on.
  "  version:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: echo \"VERSION=$(cat version.txt)\" >> \"$GITHUB_ENV\"",
  "      - run: test \"$VERSION\" = 1 && cat checked.txt",
  "  alone:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  // A step with a time limit waits for it in a process of its own, and is reused like any other.
  "      - run: cat checked.txt",
  "        timeout-minutes: 5",
  "  sha:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: echo \"STARTED=yes\" >> \"$GITHUB_ENV\"",
  "      - run: test -n \"$GITHUB_SHA\" && test \"$STARTED\" = yes && cat checked.txt",
  ""
].join("\n")

describe("a workflow whose steps pass values through GITHUB_ENV", () => {
  it.skipIf(!observes)(
    "reuses a step until a file it opened or a value an earlier step gave it changes",
    async () => {
      const root = temporary("observed-runner")
      made.push(root)
      git(root, "init", "--quiet", "--initial-branch=main")
      commit(root, "base", {
        ".github/workflows/ci.yml": workflow,
        "checked.txt": "ok\n",
        "docs/readme.md": "# Fixture\n",
        "version.txt": "1\n"
      })
      commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
      commit(root, "version 2", { "version.txt": "2\n" })
      commit(root, "version 1 again", { "version.txt": "1\n" })
      commit(root, "the checked file changes", { "checked.txt": "still ok\n" })

      const outcome = await spawn(bin, ["--commits", "5", "--no-apply-check", "--json"], root)
      expect(outcome.stderr).not.toContain("reads are not observed")
      const report = JSON.parse(outcome.stdout) as ReplayReport
      const subjects = git(root, "log", "--reverse", "--format=%H %s", "-5").trim().split("\n")
      const normal = (subject: string) => {
        const hash = subjects.find((line) => line.endsWith(` ${subject}`))?.split(" ")[0]
        const replayed = report.commits.find((entry) => entry.commit === hash)
        const counts = replayed?.normal?.counts
        return {
          baseline: replayed?.baseline.ok,
          hit: counts?.hit,
          failed: counts?.failed,
          steps: counts === undefined ? undefined : counts.hit + counts.ran + counts.failed + counts.skipped,
          mismatches: replayed?.mismatches
        }
      }
      // Five commands: two that pass a value on, which always run, and three checks.
      expect(normal("base")).toEqual({ baseline: true, hit: 0, failed: 0, steps: 5, mismatches: [] })
      // No check opened the docs. The one that names the commit runs again: its commit is another.
      expect(normal("docs only")).toEqual({ baseline: true, hit: 2, failed: 0, steps: 5, mismatches: [] })
      // The check of `version` was given another VERSION, so it runs again and fails as the workflow does on GitHub.
      expect(normal("version 2")).toEqual({ baseline: false, hit: 1, failed: 1, steps: 5, mismatches: [] })
      // Every value and file is as a passing run found it.
      expect(normal("version 1 again")).toEqual({ baseline: true, hit: 2, failed: 0, steps: 5, mismatches: [] })
      // All three checks opened the file.
      expect(normal("the checked file changes")).toEqual({
        baseline: true,
        hit: 0,
        failed: 0,
        steps: 5,
        mismatches: []
      })
      expect(report.mismatches).toBe(0)
      expect(outcome.code).toBe(0)
    },
    540_000
  )
})
