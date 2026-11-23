/**
 * A step that checks a build is up to date, after the step that built it was
 * reused.
 *
 * `make -q out` passes on a runner: `make out` ran a moment before, so `out`
 * is newer than `in`. The third ship review's blocker 3: in normal mode the
 * build step was answered from its record and `out` was put back with the
 * time of the run it was kept from, older than the `in` of a checkout made
 * now, so the check failed where the CI passes. What a step left is now put
 * back as if the step had just run.
 *
 * The real program replays four commits with the real `smthrs`, the real
 * tracer and the real `make`, so the case runs on a Linux host that has both.
 */
import { existsSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { bin, commit, git, observes, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  makeq:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: make out",
  "      - run: cat t2.txt; make -q out",
  ""
].join("\n")

describe("a step that checks a build is up to date", () => {
  it.skipIf(!observes || !existsSync("/usr/bin/make"))("passes after the build step was reused", async () => {
    const root = temporary("put-back-times")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", {
      ".github/workflows/ci.yml": workflow,
      ".gitignore": "out\n",
      "Makefile": "out: in\n\tcp in out\n",
      "docs/readme.md": "# Fixture\n",
      "in": "1\n",
      "t2.txt": "a\n"
    })
    commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
    commit(root, "the file the check reads", { "t2.txt": "b\n" })
    commit(root, "the file the check reads, again", { "t2.txt": "c\n" })
    const outcome = await spawn(bin, ["--commits", "4", "--json", "--no-trial"], root)
    expect(outcome.stderr).not.toContain("reads are not observed")
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(
      report.commits.map((entry) => [
        entry.baseline.ok,
        entry.normal?.ok,
        entry.normal?.counts.hit,
        entry.mismatches.length
      ])
    ).toEqual([
      [true, true, 0, 0],
      [true, true, 2, 0],
      // Only the check reads the changed file: the build is reused, `out` is put back, and the check passes.
      [true, true, 1, 0],
      [true, true, 1, 0]
    ])
    expect(report.mismatches).toBe(0)
    expect(outcome.code).toBe(0)
  }, 540_000)
})
