/**
 * A job's home is told to its steps the same way in the baseline and in normal mode.
 *
 * Smithers build tells a target on a machine where its home keeps its cache, configuration, data and state. A
 * baseline step of the same job was told its home and its cache directory only, so a step that read one of the
 * other three variables read nothing in the baseline and a path in normal mode: one command, two answers.
 */
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

/** Each passes only where the variable names the place under the job's own home that a tool looks in anyway. */
const checks = [
  "test \"$XDG_CACHE_HOME\" = \"$HOME/.cache\"",
  "test \"$XDG_CONFIG_HOME\" = \"$HOME/.config\"",
  "test \"$XDG_DATA_HOME\" = \"$HOME/.local/share\"",
  "test \"$XDG_STATE_HOME\" = \"$HOME/.local/state\"",
  // No tool is told where to keep a cache of its own: each finds its usual place under that home.
  "test -z \"${GOCACHE+set}${GOMODCACHE+set}${GOFLAGS+set}${ZIG_LOCAL_CACHE_DIR+set}${ZIG_GLOBAL_CACHE_DIR+set}\"",
  "test -z \"${CARGO_HOME+set}${npm_config_cache+set}${PIP_CACHE_DIR+set}${YARN_CACHE_FOLDER+set}\""
]

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  home:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  `      - run: ${JSON.stringify(checks.join(" && "))}`,
  ""
].join("\n")

describe("the variables that say where a job's home keeps things", () => {
  it("are the same in the baseline and in normal mode", async () => {
    const root = temporary("job-home")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", { ".github/workflows/ci.yml": workflow, "notes.txt": "one\n" })
    commit(root, "notes", { "notes.txt": "two\n" })
    const outcome = await spawn(bin, ["--commits", "1", "--no-trial", "--no-apply-check", "--json"], root)
    expect(outcome.code, outcome.stderr).toBe(0)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    const [replayed] = report.commits
    expect([replayed!.baseline.failures ?? [], replayed!.normal.failures ?? []]).toEqual([[], []])
    expect(replayed!.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(replayed!.normal.counts.hit + replayed!.normal.counts.ran).toBe(1)
    expect(report.mismatches).toBe(0)
  }, 540_000)
})
