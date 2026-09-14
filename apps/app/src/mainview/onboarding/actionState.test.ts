import { expect, test } from "bun:test"
import type { Card } from "../state/AppState"
import { initialGuide } from "../state/AppState"
import { guideActionState } from "./actionState"

const action = { label: "Run repro", key: "r", flow: "issue.repro" }
const card = (phase: string, playthrough = 0, observationError?: string): Card => ({
  id: "research", kind: "run-trace", title: "Research", status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: "practice:hello-server", workflow: "issue.research", runId: "run", phase, steps: [], result: null, lastSeq: 0, observationError,
    input: { liveTutorial: { operation: "research", playthrough } } },
}) as Card

test("current live operation disables duplicate launches and offers retry after failure", () => {
  for (const phase of ["launching", "running"]) {
    expect(guideActionState(action, [card(phase)], initialGuide())).toMatchObject({ label: "Researching issue…", busy: true, disabled: true })
  }
  expect(guideActionState(action, [card("failed")], initialGuide())).toMatchObject({ label: "Retry repro", flow: "tutorial.live.retry", args: "research" })
  expect(guideActionState(action, [card("completed")], { ...initialGuide(), completed: ["issue.researched"] })).toMatchObject({ label: "Research complete", disabled: true })
})

test("observation failure reconnects and expiry restarts, while old playthroughs never block", () => {
  expect(guideActionState(action, [card("running", 0, "Connection lost")], initialGuide())).toMatchObject({ label: "Reconnect to run", flow: "tutorial.live.retry", args: "research" })
  expect(guideActionState(action, [card("failed", 0, "Session expired")], initialGuide())).toMatchObject({ label: "Start new tutorial", flow: "onboarding.act", args: "restart" })
  expect(guideActionState(action, [card("running")], { ...initialGuide(), playthrough: 1 })).toEqual(action)
})


test("returning to a completed Change's picker can create the selected Change again", () => {
  const completed = card("completed")
  if (completed.kind !== "run-trace") throw Error("run fixture")
  completed.payload.input = { liveTutorial: { operation: "change", playthrough: 0 } }
  const change = { label: "Make the Change", key: "g", flow: "change.open", args: "{picked}" }
  expect(guideActionState(change, [completed], initialGuide())).toEqual(change)
})
