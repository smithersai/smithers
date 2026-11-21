/**
 * A step that runs unrecorded because its recorded run failed says so.
 *
 * Where a step runs with its reads recorded and fails, and passes run plainly, the plain run is the verdict and
 * the step is not recorded again for a day. A step of the same job waits for it, so it runs at every commit. The
 * fourth ship review's replay of rs/xid: the reason a person read was the one for a machine that cannot record a
 * run, `a step after it may read what it leaves, and its reads are not recorded`, which says nothing of what
 * happened.
 *
 * The real program replays the repository, with this machine's tracer.
 */
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, observes, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

/**
 * A step that refuses to run under a tracer, as a debugger or a program that traces another does. The shell asks
 * about itself, with its own builtins, after it sets a handler: smthrs-observe traces a process only once it sets a
 * handler, and lets it go when it starts another program, so a `grep` of `/proc/self/status` finds no tracer there.
 */
const refuses = [
  "trap : USR1",
  "while read -r key value; do if [ \"$key\" = TracerPid: ] && [ \"$value\" != 0 ]; then exit 1; fi; done < /proc/self/status",
  "echo built > out.txt"
].join("; ")
const reads = "grep -q built out.txt && cat notes.txt"

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  `      - run: ${JSON.stringify(refuses)}`,
  `      - run: ${JSON.stringify(reads)}`,
  ""
].join("\n")

describe.skipIf(!observes)("a step whose recorded run failed and whose plain run passed", () => {
  it("says so at every commit it runs unrecorded, with when it is recorded again", async () => {
    const root = temporary("unrecorded")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", { ".github/workflows/ci.yml": workflow, ".gitignore": "out.txt\n", "notes.txt": "one\n" })
    commit(root, "notes", { "notes.txt": "two\n" })
    commit(root, "more notes", { "notes.txt": "three\n" })
    const started = Date.now()
    const outcome = await spawn(bin, ["--commits", "2", "--no-trial", "--no-apply-check", "--json"], root)
    expect(outcome.code, outcome.stderr).toBe(0)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.commits).toHaveLength(2)
    expect(report.mismatches).toBe(0)
    for (const replayed of report.commits) {
      // The plain run is the verdict: the step passes both ways.
      expect([replayed.baseline.ok, replayed.normal.ok]).toEqual([true, true])
      const first = (replayed.normal.notReused ?? []).find((entry) => entry.step === "ci.yml:build:1")
      const said =
        /^its recorded run failed and its plain run passed; it runs unrecorded until (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC$/
          .exec(first?.reason ?? "")
      expect(said, JSON.stringify(replayed.normal.notReused)).not.toBeNull()
      // A day after the recorded run that failed.
      const until = Date.parse(`${said![1]}T${said![2]}:00Z`)
      expect(until).toBeGreaterThanOrEqual(started + 24 * 60 * 60 * 1000 - 60_000)
      expect(until).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000)
    }
    // Nowhere does the report give the reason of a machine that cannot record a run.
    expect(JSON.stringify(report)).not.toContain("its reads are not recorded")
  }, 540_000)
})
