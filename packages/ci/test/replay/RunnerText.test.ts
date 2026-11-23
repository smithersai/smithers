/**
 * A step with runner text: the replay tells it where this machine keeps a runner's software, and gives it its job's
 * own temporary directory, as a runner gives every step one.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

const replayed = (root: string, options: Partial<typeof Options.Service>, cache?: string) =>
  Effect.runPromise(
    run(
      { root, commits: 1, modes: ["normal"], ...(cache === undefined ? {} : { cache }) },
      parts("none") as unknown as ReplayParts<never>
    )
      .pipe(Effect.provide(Layer.provideMerge(
        Layer.succeed(Options, {
          smthrs: [smthrs],
          reruns: 1,
          prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
          confine: unconfined,
          ...options
        }) as never,
        NodeServices.layer
      ))) as Effect.Effect<ReplayReport>
  )

it("gives a step with runner text its job's own temporary directory", async () => {
  const root = makeSmallRepository([{
    ...job("r", `test -d "$SMTHRS_MACHINE_TMP"`),
    steps: [{
      id: "r0",
      command: `test -d "$SMTHRS_MACHINE_TMP"`,
      cwd: "",
      env: {},
      secrets: [],
      runner: `__smithers_ci_step() { sh -c "$1"; }`
    }]
  }])
  made.push(root)
  const report = await replayed(root, {})
  // The baseline runs the step's runner text as the CI does. (These tests' own targets run the bare command.)
  expect(report.commits[0]?.baseline).toMatchObject({ ok: true, counts: { ran: 1, failed: 0 } })
}, 600_000)
