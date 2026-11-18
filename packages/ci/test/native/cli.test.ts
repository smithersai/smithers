import * as Schema from "effect/Schema"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { parts } from "../../src/cli/parts.ts"
import { exitCodes } from "../../src/contract/Command.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { footer } from "../../src/native/index.ts"
import { inProcess } from "../cli/inProcess.vibe"
import { bin, changed, type Outcome, recorder, snapshot, spawn, temporary } from "../cli/repo.ts"
import { makeOwnWith, smthrs } from "./own.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })))

const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

const run = async (args: ReadonlyArray<string>, root: string): Promise<Outcome> => {
  const sink = recorder()
  const code = await inProcess(args, root, parts, sink.service as never, environment)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

describe("smithers-ci on a repository that builds with Smithers build", { timeout: 300_000 }, () => {
  it("replays the repository's own targets by default and says nothing was converted", async () => {
    const root = keep(makeOwnWith(smthrs))
    const before = snapshot(root)
    const outcome = await run(["--commits", "1"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout.trimEnd().endsWith(`\n\n${footer("WORKSPACE.ts")}`)).toBe(true)
    expect(outcome.stdout).not.toContain("apply would write")
    expect(outcome.stdout.startsWith("own targets  //:a //:b //:c\n\n")).toBe(true)
    expect(outcome.stderr).toContain(
      "smithers-ci: replaying the repository's own targets (WORKSPACE.ts): //:a //:b //:c"
    )
    expect(changed(before, snapshot(root))).toEqual([])
  })

  it("replays the patterns --targets names and prints the report as JSON, as a process", async () => {
    const root = keep(makeOwnWith(smthrs))
    const outcome = await spawn(bin, ["replay", "--commits", "1", "--json", "--targets", "//:a,//:b"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    const report = Schema.decodeUnknownSync(ReplayReport)(JSON.parse(outcome.stdout))
    expect(report.commits).toHaveLength(1)
    expect(report.targets).toEqual(["//:a", "//:b"])
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(report.mismatches).toBe(0)
    // The CI's third pattern was not asked for, so its job is left out with the job that runs no target.
    expect(report.notReplayed?.map((entry) => entry.job)).toEqual(["ci.yml:targets", "ci.yml:docs"])
  })

  it("words the footer once", () => {
    expect(footer(".smithers/WORKSPACE.ts")).toBe(
      "This repository already builds with Smithers build (.smithers/WORKSPACE.ts). The replay ran its own targets, cold against cached; there is nothing for apply to convert. This run wrote nothing to the repository."
    )
  })
})
