/** The CPU time each way's steps used, in real repositories, with the real `smthrs`. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { Options, run } from "../../src/replay/index.ts"
import { tableFor } from "../../src/replay/Stall.vibe"
import { text } from "../../src/report/index.ts"
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

/** A host that reads the processes ten times a second, from `read` when it is given. */
const host = (read?: ReturnType<typeof tableFor>["read"]): Layer.Layer<never> =>
  Layer.succeed(Options, {
    smthrs: [smthrs] as const,
    reruns: 0,
    prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
    confine: unconfined,
    cpuTick: "100 millis",
    ...(read === undefined ? {} : { processes: { ...tableFor(), read } })
  }) as never

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

  it("is in no report on a machine whose processes cannot be read", async () => {
    const root = track(makeSmallRepository([job("works", work)]))
    const report = await start(root, host(Effect.succeed(undefined)))
    const [commit] = report.commits
    expect(commit?.baseline.ok).toBe(true)
    expect(commit?.baseline).not.toHaveProperty("cpuMs")
    expect(commit?.normal).not.toHaveProperty("cpuMs")
    expect(report).not.toHaveProperty("baselineCpuMs")
    expect(report).not.toHaveProperty("normalCpuMs")
    expect(text(report)).not.toContain("CPU time")
  })
})
