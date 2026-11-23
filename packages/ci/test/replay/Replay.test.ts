import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { RunReplay } from "../../src/contract/Parts.vibe"
import { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { type Host, maxReruns, Options, run } from "../../src/replay/index.vibe"
import { makeRepository, type Repository } from "./fixture.ts"
import { options, parts } from "./TestParts.vibe"

let repository: Repository
let report: ReplayReport

beforeAll(async () => {
  repository = makeRepository()
  report = await Effect.runPromise(
    run(
      {
        root: repository.root,
        commits: 5,
        modes: ["normal", "fast"],
        jobs: 4,
        settings: { scoreCutoff: 0.5, countCutoff: 0 }
      },
      parts(repository.commits[0]!)
    ).pipe(Effect.provide(Layer.merge(options, NodeServices.layer)))
  )
}, 1_800_000)

afterAll(() => repository.remove())

const commit = (index: number) => report.commits[index]!

describe("replaying five real commits", () => {
  it("writes a report the contract decodes, oldest commit first", () => {
    expect(Schema.decodeUnknownSync(ReplayReport)(report)).toEqual(report)
    expect(report.repository).toBe("test/replay")
    expect(report.stopped).toBeUndefined()
    expect(report.commits.map((entry) => entry.commit)).toEqual(repository.commits)
    expect(report.commits.map((entry) => entry.changedFiles)).toEqual([10, 1, 3, 3, 2])
  })

  it("reports speedup as baseline wall time over normal-mode wall time, at the commits whose baseline passed", () => {
    const passed = report.commits.filter((entry) => entry.baseline.ok)
    expect(passed.map((entry) => entry.commit)).toEqual([
      repository.commits[0],
      repository.commits[1],
      repository.commits[3]
    ])
    expect(report.speedupCommits).toBe(3)
    const sum = (wall: (entry: ReplayReport["commits"][number]) => number) =>
      passed.reduce((total, entry) => total + wall(entry), 0)
    expect(report.baselineWallMs).toBe(sum((entry) => entry.baseline.wallMs))
    expect(report.normalWallMs).toBe(sum((entry) => entry.normal.wallMs))
    expect(report.speedup).toBe(report.baselineWallMs / report.normalWallMs)
    expect(report.fastWallMs).toBe(sum((entry) => entry.fast?.wallMs ?? 0))
  })

  it("reuses the cache in normal mode and never in the baseline", () => {
    expect(commit(0).normal.counts).toEqual({ hit: 0, ran: 10, failed: 0, skipped: 0 })
    expect(commit(1).normal.counts).toEqual({ hit: 9, ran: 1, failed: 0, skipped: 0 })
    expect(commit(1).baseline.counts).toEqual({ hit: 0, ran: 10, failed: 0, skipped: 0 })
    // The fix restores every script, so each green result comes back from the cache.
    expect(commit(3).normal.counts.ran).toBe(0)
    expect(commit(3).normal.counts.hit).toBe(10)
  })

  it("gives a broken commit the same verdict in the baseline and in normal mode", () => {
    for (const totals of [commit(2).baseline, commit(2).normal]) {
      expect(totals.ok).toBe(false)
      expect(totals.counts.failed).toBe(3)
      // b waits on a; d's second step waits on its first.
      expect(totals.counts.skipped).toBe(2)
    }
    expect(commit(2).mismatches.filter((entry) => entry.mode === "normal")).toEqual([])
  })

  it("settles a flaky target by rerunning it, then runs what waited on it", () => {
    for (const totals of [commit(4).baseline, commit(4).normal]) {
      // c fails once and passes, so f runs and fails for real, and h behind f stays skipped.
      expect(totals.ok).toBe(false)
      expect(totals.counts.failed).toBe(1)
      expect(totals.counts.skipped).toBe(1)
    }
    expect(commit(4).mismatches.filter((entry) => entry.mode === "normal")).toEqual([])
  })

  it("counts a fast-mode skip of a failing target as a mismatch, and of a passing one as none", () => {
    expect(commit(0).fast?.counts).toEqual({ hit: 0, ran: 0, failed: 0, skipped: 10 })
    expect(commit(0).mismatches).toEqual([])
    // a0 is also skipped by the scorer, but b0 needs it, so it runs and fails. k0 has no dependent.
    expect(commit(2).mismatches).toEqual([{ label: "//:k0_0", mode: "fast", baseline: "fail", got: "skipped" }])
    expect(report.mismatches).toBe(1)
    expect(report.selection).toMatchObject({ failures: 4, failedChanges: 2 })
  })

  it("stores nothing for a target fast mode skipped: at the next commit, with the same inputs, it runs", () => {
    // Fast mode skipped all ten targets at the first commit. The second commit changes one script. Normal mode
    // reuses the other nine results there; fast mode has none to reuse, because a skip is no result, and runs them.
    expect(commit(0).fast?.counts.skipped).toBe(10)
    expect(commit(1).normal.counts).toEqual({ hit: 9, ran: 1, failed: 0, skipped: 0 })
    expect(commit(1).fast?.counts).toEqual({ hit: 0, ran: 9, failed: 0, skipped: 1 })
    // What it ran then is stored: the commit that restores every script reuses those nine.
    expect(commit(3).fast?.counts.hit).toBeGreaterThanOrEqual(9)
  })

  it("leaves the repository as it found it", async () => {
    const { execFileSync } = await import("node:child_process")
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repository.root, encoding: "utf8" })).toBe("")
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository.root, encoding: "utf8" }).trim()).toBe(
      repository.commits[4]
    )
  })
})

describe("run", () => {
  it("has the contract's type", () => {
    const contract: RunReplay<Host> = run
    expect(contract).toBe(run)
  })

  it("defaults to the smthrs on the path, ten reruns and no preparation", async () => {
    const defaults = await Effect.runPromise(Effect.gen(function*() {
      const found = yield* Options
      yield* found.prepare("anywhere")
      return found
    }))
    expect(defaults.smthrs).toEqual(["smthrs"])
    expect(defaults.reruns).toBe(maxReruns)
  })
})
