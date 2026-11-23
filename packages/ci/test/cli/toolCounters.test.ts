/**
 * A tool that counts its own runs in a file under the home directory, as
 * Go's tools do under `~/.config/go/telemetry`.
 *
 * Each run opens the file, reads the count and writes it back one higher. The
 * count never decides what the tool answers. Read as an input, it would run
 * every step again at every commit: the step after it changed the file the
 * step read. So the generator names the directory as a tool's own bookkeeping,
 * and a record of what a step read leaves it out.
 *
 * The real program replays two commits with the real `smthrs` and the real
 * tracer, so the case runs on a Linux host that has `strace`.
 */
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { bin, commit, git, observes, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: sh tool.sh vet",
  "      - run: sh tool.sh test",
  ""
].join("\n")

// Stands for the tool: counts the run, then reads the one file its answer depends on.
const tool = [
  "counts=\"$HOME/.config/go/telemetry/local\"",
  "mkdir -p \"$counts\"",
  "count=$(cat \"$counts/tool.count\" 2>/dev/null || echo 0)",
  "echo $((count + 1)) > \"$counts/tool.count\"",
  "grep -q ok source.txt",
  ""
].join("\n")

describe("a tool that counts its runs under the home directory", () => {
  it.skipIf(!observes)("does not run again for its own count", async () => {
    const root = temporary("tool-counters")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", {
      ".github/workflows/ci.yml": workflow,
      "docs/readme.md": "# Fixture\n",
      "source.txt": "ok\n",
      "tool.sh": tool
    })
    commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
    commit(root, "the source the tool reads", { "source.txt": "ok, still\n" })
    const outcome = await spawn(bin, ["--commits", "3", "--json", "--no-trial"], root)
    expect(outcome.stderr).not.toContain("reads are not observed")
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.commits.map((entry) => [entry.baseline.ok, entry.normal?.ok, entry.normal?.counts.hit])).toEqual([
      [true, true, 0],
      // Both steps ran the tool at the commit before, and each changed the count the other read.
      [true, true, 2],
      // The count is left out; the file the tool's answer depends on is not.
      [true, true, 0]
    ])
    expect(report.mismatches).toBe(0)
    expect(outcome.code).toBe(0)
  }, 540_000)
})
