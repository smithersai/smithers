/**
 * Every git smithers-ci starts runs no upkeep of its own.
 *
 * Git 2.29 and later run `git maintenance run --auto` after a command that
 * writes objects, and 2.47 and later start it detached, so it goes on after
 * the call has ended. A replay commits in a copy of its own: the copy that
 * holds the files `apply` writes. With no jail around that commit a detached
 * maintenance would outlive it, beside a replay that removes the copy. The
 * real program, the real git and a repository of three commits; a `git`
 * first on `PATH` hands each git process a trace of what it starts.
 */
import { execFileSync } from "node:child_process"
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { exitCodes } from "../../src/contract/Command.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { bin, changed, commit, git, pathWithout, remove, snapshot, spawnWith, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

/** A runner of this host's own system: smithers-ci replays a Linux job on Linux and a macOS job on a Mac. */
const runner = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  check:",
  `    runs-on: ${runner}`,
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: cat value.txt",
  ""
].join("\n")

/** The command line of every git process the trace directory saw start, one per process. */
const started = (traces: string): ReadonlyArray<ReadonlyArray<string>> =>
  readdirSync(traces).flatMap((name) =>
    readFileSync(join(traces, name), "utf8").split("\n").flatMap((line) => {
      if (!line.includes("\"event\":\"start\"")) return []
      return [(JSON.parse(line) as { readonly argv: ReadonlyArray<string> }).argv]
    })
  )

describe("smithers-ci on a machine with a git that keeps itself up", () => {
  it("starts no git maintenance, in the repository or in its copies, with no jail", async () => {
    const root = keep(temporary("git-upkeep"))
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", { ".github/workflows/ci.yml": workflow, "value.txt": "1\n" })
    commit(root, "second", { "value.txt": "2\n" })
    commit(root, "docs only", { "docs/readme.md": "# Fixture\n" })

    const tools = keep(temporary("git-upkeep-tools"))
    const traces = keep(temporary("git-upkeep-traces"))
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
    // Each git process the wrapper starts writes its own trace file into `traces`, its children's included.
    writeFileSync(join(tools, "git"), `#!/bin/sh\nGIT_TRACE2_EVENT=${traces} exec ${real} "$@"\n`)
    chmodSync(join(tools, "git"), 0o755)

    const before = snapshot(root)
    const outcome = await spawnWith(bin, ["--commits", "2", "--no-trial", "--json"], root, {
      PATH: `${tools}:${pathWithout("bwrap", tools)}`,
      SMITHERS_CI_ALLOW_UNCONFINED: "1"
    })
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.mismatches).toBe(0)
    // The replay committed in its copy: the run with the files `apply` writes.
    const commands = started(traces)
    expect(commands.some((argv) => argv.includes("commit"))).toBe(true)
    expect(commands.filter((argv) => argv.includes("maintenance") || argv.includes("gc"))).toEqual([])
    expect(changed(before, snapshot(root))).toEqual([])
  }, 540_000)
})
