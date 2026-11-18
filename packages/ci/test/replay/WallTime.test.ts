/** What a wall time holds: the checkout and the run, and nothing only a replay does. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { run } from "../../src/replay/index.ts"
import { job, makeSmallRepository } from "./fixture.ts"
import { parts } from "./TestParts.vibe"
import { hour, jumping } from "./WallClock.vibe"

const created: Array<string> = []
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

const replay = (moment: "prepare" | "checkout"): Promise<ReplayReport> => {
  const root = makeSmallRepository([job("a", "sh a.sh")])
  created.push(root)
  const chosen = parts("none") as unknown as ReplayParts<never>
  return Effect.runPromise(
    jumping(moment, run({ root, commits: 1, modes: ["normal", "fast"] }, chosen)).pipe(
      Effect.provide(NodeServices.layer)
    ) as Effect.Effect<ReplayReport, Failure>
  )
}

describe("the wall time of one commit", () => {
  it("leaves out what only a replay does to a copy before the targets run", async () => {
    // The clock jumps an hour while each copy gets its generated files and the package they import.
    const commit = (await replay("prepare")).commits[0]
    expect(commit?.normal.wallMs).toBeGreaterThan(0)
    expect(commit?.normal.wallMs).toBeLessThan(hour)
    expect(commit?.fast?.wallMs).toBeLessThan(hour)
    expect(commit?.baseline.wallMs).toBeLessThan(hour)
  }, 600_000)

  it("holds the checkout, in the baseline and in each mode", async () => {
    // The clock jumps an hour at each checkout: one for the baseline's job, one for each mode's copy.
    const commit = (await replay("checkout")).commits[0]
    for (const wallMs of [commit?.baseline.wallMs, commit?.normal.wallMs, commit?.fast?.wallMs]) {
      expect(wallMs).toBeGreaterThanOrEqual(hour)
      expect(wallMs).toBeLessThan(2 * hour)
    }
  }, 600_000)
})
