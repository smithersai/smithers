/** The CPU time each way's steps used, in real repositories, with the real `smthrs`. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { existsSync, rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { Options, run } from "../../src/replay/index.vibe"
import { tableFor } from "../../src/replay/Stall.vibe"
import { text } from "../../src/report/index.vibe"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (path: string): string => {
  created.push(path)
  return path
}
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

const base = parts("none") as unknown as ReplayParts<never>

type Table = ReturnType<typeof tableFor>

/** A host that reads every process of the machine each `cpuTick`, from `table` when it is given. */
const host = (table?: Table, cpuTick: Duration.Input = "100 millis"): Layer.Layer<never> =>
  Layer.succeed(Options, {
    smthrs: [smthrs] as const,
    reruns: 0,
    prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
    confine: unconfined,
    cpuTick,
    ...(table === undefined ? {} : { processes: table })
  }) as never

/** Whether this machine says which processes a process started, as a Linux kernel built to list them does. */
const listsChildren = existsSync(`/proc/${process.pid}/task/${process.pid}/children`)

const start = (root: string, options: Layer.Layer<never>) =>
  Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"] }, base).pipe(
      Effect.provide(Layer.provideMerge(options, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

// Work measured in CPU time, not in time on the clock, done by a process the step starts and waits for.
const work = "sh -c 'i=0; while [ $i -lt 1000000 ]; do i=$((i+1)); done'"

describe("the CPU time of a replay's steps", { timeout: 600_000 }, () => {
  it("is in the report for each way, for a commit and over the commits the times cover", async () => {
    const root = track(makeSmallRepository([job("works", work), job("waits", "sleep 1")]))
    const report = await start(root, host())
    const [commit] = report.commits
    // The step's own work, in the baseline and as a target; a target's run also holds what starts it.
    expect(commit?.baseline.cpuMs).toBeGreaterThan(300)
    expect(commit?.normal.cpuMs).toBeGreaterThan(300)
    expect(report.baselineCpuMs).toBe(commit?.baseline.cpuMs)
    expect(report.normalCpuMs).toBe(commit?.normal.cpuMs)
    expect(report).not.toHaveProperty("fastCpuMs")
    expect(text(report)).toMatch(/^the steps used .+ of CPU time as the baseline and .+ in normal mode/m)
  })

  it.skipIf(!listsChildren)(
    "holds a step that ended before every process of the machine was read once, where a step's processes are read alone",
    async () => {
      const root = track(makeSmallRepository([job("works", work)]))
      // The whole machine is never read while the step runs; the processes under the step are, four times a second.
      const report = await start(root, host(undefined, "1 hour"))
      const [commit] = report.commits
      expect(commit?.baseline.cpuMs).toBeGreaterThan(300)
      expect(commit?.normal.cpuMs).toBeGreaterThan(300)
    }
  )

  it("is read from every process of the machine where a step's processes cannot be read alone", async () => {
    const root = track(makeSmallRepository([job("works", work)]))
    // A kernel that lists no process's children says so when it is first asked, and a system with no such list
    // has no reader for it.
    const { under: _under, ...whole } = tableFor()
    for (const table of [{ ...tableFor(), under: () => Effect.succeed(undefined) }, whole]) {
      const report = await start(root, host(table))
      const [commit] = report.commits
      expect(commit?.baseline.cpuMs).toBeGreaterThan(300)
      expect(commit?.normal.cpuMs).toBeGreaterThan(300)
    }
  })

  it("is in no report on a machine whose processes cannot be read", async () => {
    const root = track(makeSmallRepository([job("works", work)]))
    const unread = Effect.succeed(undefined)
    const report = await start(root, host({ ...tableFor(), read: unread, under: () => unread }))
    const [commit] = report.commits
    expect(commit?.baseline.ok).toBe(true)
    expect(commit?.baseline).not.toHaveProperty("cpuMs")
    expect(commit?.normal).not.toHaveProperty("cpuMs")
    expect(report).not.toHaveProperty("baselineCpuMs")
    expect(report).not.toHaveProperty("normalCpuMs")
    expect(text(report)).not.toContain("CPU time")
  })
})
