/**
 * A step that reads the repository's workflow files, end to end.
 *
 * The real program replays three commits of a real repository with the real
 * `smthrs`, under `strace`. Lead's decision (2026-11-19): a workflow file a
 * step's program reads is read as data. GitHub runs it; the step does not. So
 * the name of a variable a runner sets, written in a workflow, does not run
 * the step again at every commit. The step's own text still counts, and the
 * workflow is an input like any other file it read.
 *
 * Lead's decision (2026-11-21): the run's id is a number GitHub makes up for
 * each run, so a step uses it only by naming it in its own text or by
 * printing, writing or passing on its value. Its name in a script the step
 * runs, or in a source it compiles, does not count. The commit's name there
 * still does.
 */
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, observes, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const workflow = (comment: string) =>
  [
    `# ${comment}`,
    "name: CI",
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "jobs:",
    // A check of the repository's own CI, as eliza's Bun pin check reads every workflow.
    "  reads:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: cat .github/workflows/ci.yml checked.txt > /dev/null",
    "  names:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: test -n \"$GITHUB_RUN_ID\" && cat checked.txt",
    "  script:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: sh ./run-id.sh",
    // A bundler that writes the run's id into what it builds.
    "  bundles:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: sh ./bundle.sh",
    "  commit:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: sh ./commit.sh",
    ""
  ].join("\n")

describe("a step that reads the workflow files", () => {
  it.skipIf(!observes)(
    "is reused while nothing it read changed, though a workflow names a variable each run sets",
    async () => {
      const root = temporary("workflow-data")
      made.push(root)
      git(root, "init", "--quiet", "--initial-branch=main")
      commit(root, "base", {
        ".github/workflows/ci.yml": workflow("one"),
        "checked.txt": "ok\n",
        "docs/readme.md": "# Fixture\n",
        "run-id.sh": "test -n \"$GITHUB_RUN_ID\" && cat checked.txt\n",
        "bundle.sh": "printenv GITHUB_RUN_ID > bundle.js && cat checked.txt\n",
        "commit.sh": "test -n \"$GITHUB_SHA\" && cat checked.txt\n"
      })
      commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
      commit(root, "the workflow changes", { ".github/workflows/ci.yml": workflow("two") })

      const outcome = await spawn(bin, ["--commits", "3", "--no-apply-check", "--json"], root)
      expect(outcome.stderr).not.toContain("reads are not observed")
      if (outcome.stdout === "") throw new Error(outcome.stderr)
      const report = JSON.parse(outcome.stdout) as ReplayReport
      const subjects = git(root, "log", "--reverse", "--format=%H %s", "-3").trim().split("\n")
      const counted = (subject: string) => {
        const hash = subjects.find((line) => line.endsWith(` ${subject}`))?.split(" ")[0]
        const replayed = report.commits.find((entry) => entry.commit === hash)
        const counts = replayed?.normal?.counts
        return [subject, replayed?.baseline.ok, counts?.hit, counts?.ran, replayed?.mismatches]
      }
      // Each line is a commit: whether the CI passes, the steps reused, the steps that ran, the mismatches.
      expect(["base", "docs only", "the workflow changes"].map(counted)).toEqual([
        ["base", true, 0, 5, []],
        // The check that reads the workflows is reused, and so is the step whose script names GITHUB_RUN_ID and uses
        // nothing of it that shows. The step whose own text names it, the bundler that wrote its value, and the step
        // whose script names GITHUB_SHA run at every commit.
        ["docs only", true, 2, 3, []],
        // The workflow the check read changed: it runs again.
        ["the workflow changes", true, 1, 4, []]
      ])
      expect(report.mismatches).toBe(0)
      expect(outcome.code).toBe(0)
    },
    540_000
  )
})
