import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { type Step, withSteps } from "../../src/contract/Inventory.ts"
import type { Decompose, Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { path as targetMapPath, type TargetMap } from "../../src/contract/TargetMap.ts"
import { run } from "../../src/replay/index.ts"
import { job, makeSmallRepository } from "./fixture.ts"
import { generated, options, parts } from "./TestParts.vibe"

const created: Array<string> = []
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

type Parts = ReplayParts<never>

/** Splits every step in two: the second half runs `second`. */
const inTwo = (second: string): Decompose<never> => (_root, ci) =>
  Effect.succeed(withSteps(ci, (entry) =>
    entry.steps.flatMap((step): ReadonlyArray<Step> => [
      { ...step, id: `${step.id}x`, from: step.id },
      { ...step, id: `${step.id}y`, from: step.id, command: second }
    ])))

/** The test generator's files, with the target map naming the step each target was split from. */
const files: Parts["files"] = (inventory) => {
  const from = new Map(inventory.jobs.flatMap((entry) => entry.steps.map((step) => [step.id, step.from ?? step.id])))
  return Effect.succeed(
    generated(inventory).map((file) => {
      if (file.path !== targetMapPath) return file
      const map = JSON.parse(file.content) as TargetMap
      const targets = map.targets.map((target) => ({ ...target, step: from.get(target.step) }))
      return { ...file, content: JSON.stringify({ ...map, targets }) }
    })
  )
}

const replay = (decompose: Decompose<never>): Promise<ReplayReport> => {
  const root = makeSmallRepository([job("a", "sh a.sh")])
  created.push(root)
  const chosen = { ...(parts("none") as unknown as Parts), files, decompose }
  return Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"] }, chosen).pipe(
      Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )
}

describe("a replay whose steps were split", () => {
  it("runs the step once in the baseline and its two targets in normal mode, and they agree", async () => {
    const [commit] = (await replay(inTwo("sh a.sh"))).commits
    expect(commit!.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(commit!.normal.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(commit!.mismatches).toEqual([])
  }, 120_000)

  it("reports the step, by its id, when one of its targets fails and the step passed", async () => {
    const report = await replay(inTwo("exit 1"))
    expect(report.commits[0]!.baseline.ok).toBe(true)
    expect(report.commits[0]!.normal.counts.failed).toBe(1)
    expect(report.commits[0]!.mismatches).toEqual([{ label: "a0", mode: "normal", baseline: "pass", got: "fail" }])
    expect(report.mismatches).toBe(1)
  }, 120_000)
})
