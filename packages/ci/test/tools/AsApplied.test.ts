/**
 * What a replay says about the files `apply` writes. The copies a replay
 * runs a commit in hold none of them. At the newest commit the steps run
 * once more in a copy that holds them, committed, as `apply` leaves a
 * repository: a tool that reads one as the repository's own fails there,
 * and the report names the tool, the file and what to add.
 */

import * as Schema from "effect/Schema"
import { afterAll, describe, expect, it } from "vitest"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { workflowPath, workspacePath } from "../../src/generate/Render.ts"
import { commit, node, program, project, removeProjects, run, write } from "./project.ts"

afterAll(removeProjects)

const workflow = (jobs: Readonly<Record<string, string | ReadonlyArray<string>>>): string =>
  [
    "name: CI",
    "on: [push, pull_request]",
    "jobs:",
    ...Object.entries(jobs).flatMap(([id, commands]) => [
      `  ${id}:`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      ...(typeof commands === "string" ? [commands] : commands).map((command) =>
        `      - run: ${JSON.stringify(command)}`
      )
    ]),
    ""
  ].join("\n")

// A spell checker told to read every tracked file, dot directories included: it stops at the generated
// workspace file, as cspell does at a word it does not know.
const spell = [
  "for file in $(git ls-files); do",
  "  case $file in",
  `    ${workspacePath}) echo "$file:2:19 - Unknown word (smthrs)"; exit 1;;`,
  "  esac",
  "done",
  ""
].join("\n")

const cause =
  `cspell read ${workspacePath}, which Smithers CI wrote. Add .smithers to "ignorePaths" in the cspell configuration.`

describe("a repository with a tool that reads every file", () => {
  it("is told, at the newest commit, which step fails over a file apply writes, and why", () => {
    const root = project({
      "spell.sh": spell,
      "src/m": "ok\n",
      ".github/workflows/ci.yml": workflow({
        spell: "sh spell.sh",
        unit: "grep -q ok src/m",
        // A step that fails beside those files and names none of them: it counts the repository's files.
        count: `test "$(git ls-files | grep -c .)" -lt 5`
      })
    }, false)
    write(root, { "src/m": "ok\n# 2\n" })
    commit(root, "a source")
    const replayed = node(root, program, ["--commits", "2", "--json"])
    expect(replayed.status, replayed.output).toBe(1)
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReplayReport))(replayed.stdout)
    expect(report.commits).toHaveLength(2)
    // Every step passes at both commits, in the baseline and in normal mode: no copy holds a generated file.
    for (const entry of report.commits) {
      expect(entry.baseline.failures ?? [], entry.commit).toEqual([])
      expect(entry.normal.failures ?? [], entry.commit).toEqual([])
      expect(entry.normal.ok, entry.commit).toBe(true)
    }
    // The older commit is not the one `apply` is run on.
    expect(report.commits[0]?.mismatches).toEqual([])
    const [spelled, counted, ...others] = report.commits[1]?.mismatches ?? []
    expect(spelled).toEqual({ label: "//:ci.yml-spell-1", mode: "normal", baseline: "pass", got: "fail", cause })
    // The step that names no file is told what happened, and which files: every one `apply` writes.
    expect(counted).toMatchObject({ label: "//:ci.yml-count-1", mode: "normal", baseline: "pass", got: "fail" })
    expect(counted?.cause).toMatch(
      /^This step passes on the commit's files and fails once the files smithers-ci apply writes are committed: .+\.$/
    )
    expect(counted?.cause).toContain(workspacePath)
    expect(counted?.cause).toContain(workflowPath)
    expect(others).toEqual([])
    expect(report.mismatches).toBe(2)
    // The run's time is its own number, beside the ways' times, and the speedup is as measured on the commit's
    // files: both commits count.
    expect(report.appliedMs).toBeGreaterThan(0)
    expect(report.speedupCommits).toBe(2)
    expect(report.speedup).toBeGreaterThan(0)
    // What the replay is running is said as it starts.
    expect(replayed.output).toMatch(/smithers-ci: 2\/2 [0-9a-f]{7} with the files apply writes\n/)
    expect(replayed.output).not.toMatch(/smithers-ci: 1\/2 [0-9a-f]{7} with the files apply writes\n/)
    // The replay wrote nothing to the repository.
    expect(run(root, "git", ["status", "--porcelain", "--ignored"]).stdout).toBe("")

    // In words: the line under the mismatch.
    const printed = node(root, program, ["--commits", "1"])
    expect(printed.status, printed.output).toBe(1)
    expect(printed.stdout).toMatch(
      /normal +\/\/:ci\.yml-spell-1 +pass → fail\n +cspell read \.smithers\/WORKSPACE\.smithers, which Smithers CI wrote\./
    )
    expect(printed.stdout).toMatch(
      /\nran the newest commit once more with the files apply writes in [^,]+, which is in none of these times\n/
    )

    // Left out by the person, the run does not happen: every step passes on the commit's files.
    const without = node(root, program, ["--commits", "1", "--json", "--no-apply-check"])
    expect(without.status, without.output).toBe(0)
    expect(without.output).not.toContain("with the files apply writes")
    const plain = Schema.decodeUnknownSync(Schema.fromJsonString(ReplayReport))(without.stdout)
    expect(plain.mismatches).toBe(0)
    expect(plain.appliedMs).toBeUndefined()
  }, 3_600_000)

  // More than 32 steps share one group of the repository's files, and a run record lists the group beside them.
  it("runs the steps once more in a repository whose steps share one group of files", () => {
    const jobs = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`unit${index}`, "grep -q ok src/m"]))
    const root = project({ "src/m": "ok\n", ".github/workflows/ci.yml": workflow(jobs) }, false)
    const replayed = node(root, program, ["--commits", "1", "--json"])
    expect(replayed.status, replayed.output).toBe(0)
    expect(replayed.output).toMatch(/smithers-ci: 1\/1 [0-9a-f]{7} with the files apply writes\n/)
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReplayReport))(replayed.stdout)
    expect(report.commits[0]?.normal.counts).toMatchObject({ failed: 0, skipped: 0 })
    expect(report.mismatches).toBe(0)
    expect(report.appliedMs).toBeGreaterThan(0)
  }, 3_600_000)

  it("gives every step the commit a person pushes after apply: its id, its message, its place in the history", () => {
    // A program that writes down the commit it is given, by a name no shell text holds.
    const writes = (file: string): string =>
      `require("fs").writeFileSync(${JSON.stringify(file)}, process.env["GITHUB" + "_SHA"])\n`
    const kept = `/tmp/smithers-ci-as-applied-${process.pid}`
    const head = `"$(git rev-parse HEAD)"`
    const root = project({
      "docs/r.md": "1\n",
      "count.txt": "1\n",
      "w.js": writes(kept),
      "w2.js": writes("sha.out"),
      ".github/workflows/ci.yml": workflow({
        // The commit a step is given is the one checked out, as a variable and in the workflow's own words.
        shaeq: `test "$GITHUB_SHA" = ${head}`,
        expression: `test "\${{ github.sha }}" = ${head}`,
        // The newest message is the person's own, and so is the number of commits.
        message: "git log -1 --format=%s | grep -qE '^(feat|fix|docs|chore)(\\(.+\\))?: '",
        count: `test "$(git rev-list --count HEAD)" = "$(cat count.txt)"`,
        // A step writes down the commit it was given, and the next compares it with the one checked out.
        shatmp: ["node w.js", `test "$(cat ${kept})" = ${head}`],
        shafile: ["node w2.js", `test "$(cat sha.out)" = ${head}`],
        // A step that truly fails beside the files: the repository then holds `.smithers`.
        layout: `test -z "$(ls -A | grep -E '^\\.smithers$')"`
      })
    }, false)
    write(root, { "docs/r.md": "2\n", "count.txt": "2\n" })
    commit(root, "docs: the readme")
    write(root, { "docs/r.md": "3\n", "count.txt": "3\n" })
    commit(root, "fix: a word")
    const replayed = node(root, program, ["--commits", "2", "--json"])
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReplayReport))(replayed.stdout)
    expect(report.commits).toHaveLength(2)
    for (const entry of report.commits) {
      expect(entry.baseline.failures ?? [], entry.commit).toEqual([])
      expect(entry.normal.failures ?? [], entry.commit).toEqual([])
    }
    expect(replayed.output).toMatch(/smithers-ci: 2\/2 [0-9a-f]{7} with the files apply writes\n/)
    expect(report.commits[0]?.mismatches).toEqual([])
    // Every step that reads the commit passes in that run too. The one that fails is the one the files break.
    expect(report.commits[1]?.mismatches.map((entry) => entry.label)).toEqual(["//:ci.yml-layout-1"])
    expect(report.commits[1]?.mismatches[0]?.cause).toMatch(
      /^This step passes on the commit's files and fails once the files smithers-ci apply writes are committed: /
    )
    expect(report.mismatches).toBe(1)
    expect(replayed.status, replayed.output).toBe(1)
    expect(report.speedupCommits).toBe(2)
    // The replay wrote nothing to the repository.
    expect(run(root, "git", ["status", "--porcelain", "--ignored"]).stdout).toBe("")
    expect(run(root, "git", ["log", "-1", "--format=%s"]).stdout).toBe("fix: a word\n")
  }, 3_600_000)

  it("has nothing more to run in a repository that holds what apply writes", () => {
    const root = project({
      "src/m": "ok\n",
      ".github/workflows/ci.yml": workflow({ unit: "grep -q ok src/m" })
    }, false)
    const wrote = node(root, program, ["apply"])
    expect(wrote.status, wrote.output).toBe(0)
    commit(root, "smithers-ci apply")
    const replayed = node(root, program, ["--commits", "1", "--json"])
    expect(replayed.status, replayed.output).toBe(0)
    expect(replayed.output).not.toContain("with the files apply writes")
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReplayReport))(replayed.stdout)
    expect(report.mismatches).toBe(0)
    expect(report.appliedMs).toBeUndefined()
  }, 3_600_000)
})
