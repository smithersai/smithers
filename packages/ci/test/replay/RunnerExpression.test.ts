/**
 * A job whose runner is an expression over its matrix, replayed and applied in a real repository: the variants on
 * this machine's system run, the others are left out by name, and `apply` writes each variant where the replay put
 * it.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { bin, commit, git, remove, spawn, temporary } from "../cli/repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

/** A real replay runs each commit up to three ways; a busy machine takes minutes. */
const replayLimit = 540_000

const [here, other, system] = process.platform === "darwin"
  ? ["macos-latest", "ubuntu-latest", "linux"]
  : ["ubuntu-latest", "macos-latest", "darwin"]

const workflow = `
on: push
jobs:
  tests:
    name: \${{ matrix.name }}
    runs-on: \${{ matrix.os || (matrix.pool && vars.POOL) || '${here}' }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - {name: plain}
          - {name: other, os: ${other}}
          - {name: windows, os: windows-latest}
          - {name: pooled, pool: big}
    steps:
      - run: sh test.sh \${{ matrix.name }}
`

const repository = (): string => {
  const root = temporary("runner-expression")
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "ci", { ".github/workflows/ci.yml": workflow, "test.sh": "echo \"ran $1\"\n" })
  return root
}

describe("a runner picked by an expression over the matrix", () => {
  it("replays the variants on this machine's system and leaves the others out by name", async () => {
    const root = repository()
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check", "--no-trial", "--json"], root, process.env)
    expect(outcome.code, outcome.stderr).toBe(0)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.notReplayed).toEqual([{
      job: "ci.yml:tests",
      reasons: [
        {
          feature: "other-system",
          detail: `ci.yml:tests (name=other, os=${other}) runs on ${system}; this machine is ${process.platform}`
        },
        {
          feature: "other-system",
          detail: `ci.yml:tests (name=windows, os=windows-latest) runs on win32; this machine is ${process.platform}`
        },
        {
          feature: "runner",
          detail:
            `ci.yml:tests (name=pooled, pool=big) picks its runner from \${{ matrix.os || (matrix.pool && vars.POOL) || '${here}' }}`
        }
      ]
    }])
    // One variant ran, the same way both times.
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.commits[0]?.mismatches).toEqual([])
  }, replayLimit)

  it("writes each variant where the replay put it", async () => {
    const root = repository()
    const applied = await spawn(bin, ["apply"], root, process.env)
    expect(applied.code, applied.stderr).toBe(0)
    const generated = parseYaml(readFileSync(join(root, ".github", "workflows", "smithers-ci.yml"), "utf8")) as {
      readonly jobs: {
        readonly ci: {
          readonly strategy: { readonly matrix: { readonly include: ReadonlyArray<{ readonly os: string }> } }
        }
      }
    }
    // The variant on another system runs alone on its own runner, as a job on GitHub does.
    expect(generated.jobs.ci.strategy.matrix.include.map((entry) => entry.os).sort()).toEqual([here, other].sort())
    const targets = readFileSync(join(root, ".smithers", "WORKSPACE.smithers"), "utf8")
    expect(targets).toContain("sh test.sh plain")
    expect(targets).toContain("sh test.sh other")
    expect(targets).not.toContain("sh test.sh pooled")
    const notes = join(root, ".smithers", "ci", "NOT-REPRODUCED.txt")
    expect(existsSync(notes)).toBe(true)
    expect(readFileSync(notes, "utf8")).toContain(
      `ci.yml:tests: a variant picks its runner from \${{ matrix.os || (matrix.pool && vars.POOL) || '${here}' }}`
    )
  }, replayLimit)
})
