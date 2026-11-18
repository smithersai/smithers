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

const workflow = (jobs: Readonly<Record<string, string>>): string =>
  [
    "name: CI",
    "on: [push, pull_request]",
    "jobs:",
    ...Object.entries(jobs).flatMap(([id, command]) => [
      `  ${id}:`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      `      - run: ${JSON.stringify(command)}`
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
    // The run's time is its own number, beside the ways' times.
    expect(report.appliedMs).toBeGreaterThan(0)
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
