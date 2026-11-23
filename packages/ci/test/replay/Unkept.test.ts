/**
 * A step that leaves a program running where nothing keeps a job's programs or ends them: no jail and no reaper, as on
 * a Mac. The replay notes the processes before the step and ends what the step left in its checkout when it ends, so
 * nothing of it outlives the replay. Forced here by giving the replay no reaper, so it holds on every host.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { afterAll, expect, it } from "vitest"
import type { ReplayParts } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { Options, run } from "../../src/replay/index.vibe"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"

const made: Array<string> = []
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true })
})

/** The programs of this user whose whole command line is `sleep <seconds>`, by process id. */
const sleeping = (seconds: number): ReadonlyArray<string> => {
  const found = spawnSync("pgrep", ["-u", String(process.getuid?.()), "-x", "-f", `sleep ${seconds}`], {
    encoding: "utf8"
  })
  if (found.status !== 0 && found.status !== 1) throw new Error(`pgrep failed: ${found.stderr}`)
  return found.stdout.split("\n").filter((line) => line !== "")
}

it("ends what a step left running in its checkout when nothing keeps or reaps it", async () => {
  const seconds = 91_000 + (process.pid % 9_000)
  const root = makeSmallRepository([job("left", `sleep ${seconds} > /dev/null 2>&1 &`)])
  made.push(root)
  const report = await Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"] }, parts("none") as unknown as ReplayParts<never>).pipe(
      Effect.provide(Layer.provideMerge(
        Layer.succeed(Options, {
          smthrs: [smthrs],
          reruns: 1,
          prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
          confine: unconfined,
          reaper: () => undefined
        }) as never,
        NodeServices.layer
      ))
    ) as Effect.Effect<ReplayReport>
  )
  expect(report.commits[0]?.baseline).toMatchObject({ ok: true, counts: { ran: 1, failed: 0 } })
  expect(sleeping(seconds)).toEqual([])
}, 600_000)
