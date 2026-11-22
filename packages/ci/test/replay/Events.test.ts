/**
 * The event file a runner gives every step: a replay writes it for each commit, outside every step, where
 * `SMITHERS_CI_EVENTS` names it, with the commit the step runs at.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { commitMark } from "../../src/contract/Inventory.ts"
import type { ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { run } from "../../src/replay/index.ts"
import { job, makeSmallRepository } from "./fixture.ts"
import { options, parts } from "./TestParts.vibe"

const made: Array<string> = []
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true })
})

it("gives a step that names it the event file of the commit it runs at", async () => {
  const root = makeSmallRepository([
    job("event", `grep -q "$(git rev-parse HEAD)" "$SMITHERS_CI_EVENTS/push.json"`)
  ])
  made.push(root)
  const ci = JSON.parse(readFileSync(join(root, "ci.json"), "utf8")) as Record<string, unknown>
  writeFileSync(
    join(root, "ci.json"),
    JSON.stringify({ ...ci, events: { push: JSON.stringify({ after: commitMark }) } })
  )
  const git = (...args: ReadonlyArray<string>) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" })
  git("add", "-A")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--amend", "--no-edit")
  const report = await Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"] }, parts("none") as unknown as ReplayParts<never>).pipe(
      Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
    ) as Effect.Effect<ReplayReport>
  )
  // The baseline runs the step as the CI does. (These tests' own targets declare no variables, so a target here is
  // not given the file; what the generator writes for a target is tested with it.)
  const [commit] = report.commits
  expect(commit?.baseline).toMatchObject({ ok: true, counts: { ran: 1, failed: 0 } })
}, 600_000)
