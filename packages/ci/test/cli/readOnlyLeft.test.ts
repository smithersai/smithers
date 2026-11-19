/**
 * A step that leaves directories nothing can be removed from, as Go leaves
 * its module cache in the home of every job.
 *
 * Smithers build sets the machines of a run aside and removes them with a
 * command nobody waits for. In the jail that command ends with the build, so
 * what it had not removed stays in the replay's own directory, read-only
 * directories and all. The replay still removes its directory and prints its
 * report: the real program, the real `smthrs`, one small repository.
 */
import { readdirSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { exitCodes } from "../../src/contract/Command.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, changed, commit, git, remove, snapshot, spawnWith, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

/**
 * What the step leaves in its home: 300 read-only directories of 100 files each. Removing them takes the command
 * Smithers build leaves behind far longer than the build takes to end, on an idle machine and on a busy one.
 */
const leaves = [
  "mkdir -p ~/kept/mod && cd ~/kept/mod && seq 1 300 | xargs mkdir",
  "for d in *; do (cd \"$d\" && seq 1 100 | xargs touch); done",
  "chmod -R a-w ~/kept"
].join(" && ")

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  `      - run: ${JSON.stringify(leaves)}`,
  ""
].join("\n")

describe("a job that leaves read-only directories in its home", () => {
  it("is replayed to a report, and the replay's own directory is removed", async () => {
    const root = keep(temporary("read-only-left"))
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", { ".github/workflows/ci.yml": workflow, "docs/readme.md": "# Fixture\n" })
    // Two commits: the run before the counted commit leaves its machines too, as every run but a replay's first does.
    commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
    // The replay's directory is made in the temporary directory the program is given: this one holds no other.
    const temp = keep(temporary("read-only-left-tmp"))
    const before = snapshot(root)
    const outcome = await spawnWith(bin, ["--commits", "1", "--no-apply-check", "--json"], root, { TMPDIR: temp })
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    // Making the replay's directory removable changed nothing of the repository, whose objects its clone links to.
    expect(changed(before, snapshot(root))).toEqual([])
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.commits).toHaveLength(1)
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    const normal = report.commits[0]?.normal.counts
    expect([(normal?.hit ?? 0) + (normal?.ran ?? 0), normal?.failed, normal?.skipped]).toEqual([1, 0, 0])
    expect(report.mismatches).toBe(0)
    expect(readdirSync(temp).filter((name) => name.startsWith("smithers-ci-"))).toEqual([])
  }, 540_000)
})
