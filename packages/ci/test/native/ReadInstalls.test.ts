/**
 * A repository whose targets need what a sub-package's install brings, replayed through the program in this
 * process: each commit installs every directory whose lockfile a replayed target names.
 */
import * as Schema from "effect/Schema"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { parts } from "../../src/cli/parts.vibe"
import { exitCodes } from "../../src/contract/Command.vibe"
import { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { inProcess } from "../cli/inProcess.vibe"
import { type Outcome, recorder, temporary } from "../cli/repo.ts"
import { brokenInstall, toolFiles } from "./own.ts"
import { commit, repository } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })))

const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

/** The program in this process, with its console recorded. */
const run = async (args: ReadonlyArray<string>, root: string): Promise<Outcome> => {
  const sink = recorder()
  const code = await inProcess(args, root, parts, sink.service as never, environment)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

describe("a repository whose targets need a tool a sub-package installs", { timeout: 900_000 }, () => {
  it("installs that sub-package at every commit, and measures both ways with the same verdicts", async () => {
    const root = keep(repository(toolFiles()))
    commit(root, "change what the tool prints", { "greet.txt": "hello again\n" })
    commit(root, "change a file no target reads", { "notes.md": "notes\n" })
    const outcome = await run(["--commits", "2", "--json"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    const report = Schema.decodeUnknownSync(ReplayReport)(JSON.parse(outcome.stdout))
    expect(report.mismatches).toBe(0)
    const [changed, unchanged] = report.commits
    expect([changed?.baseline.counts, changed?.normal.counts, unchanged?.baseline.counts]).toEqual([
      { hit: 0, ran: 2, failed: 0, skipped: 0 },
      { hit: 0, ran: 2, failed: 0, skipped: 0 },
      { hit: 0, ran: 2, failed: 0, skipped: 0 }
    ])
    // Normal mode reuses the cache when nothing a target reads changed. Smithers build may still run a target that
    // nothing confines when a target that waits for it runs, so only the use of the cache is asserted.
    expect(unchanged?.normal.counts).toMatchObject({ failed: 0, skipped: 0 })
    expect(unchanged?.normal.counts.hit).toBeGreaterThan(0)
    expect(report.speedup).toBeGreaterThan(0)
    expect(report.notReplayed ?? []).toEqual([])
  })

  it("fails a commit whose sub-package install fails, in both ways, with the command and its directory", async () => {
    const root = keep(repository(toolFiles()))
    commit(root, "break the tool's install", { "tool/tools/install.mjs": brokenInstall })
    commit(root, "fix the tool's install", { "tool/tools/install.mjs": toolFiles()["tool/tools/install.mjs"] ?? "" })
    const outcome = await run(["--commits", "2", "--json", "--no-trial"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    const report = Schema.decodeUnknownSync(ReplayReport)(JSON.parse(outcome.stdout))
    expect(report.mismatches).toBe(0)
    expect(report.commits.map((entry) => [entry.baseline.ok, entry.normal.ok])).toEqual([[false, false], [true, true]])
    expect(outcome.stderr).toContain("(install) failed: npm ci --no-audit --no-fund exited 1 in tool")
  })
})
