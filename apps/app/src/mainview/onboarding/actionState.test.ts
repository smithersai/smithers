import { expect, test } from "bun:test"
import type { Card } from "../state/AppState"
import { initialGuide } from "../state/AppState"
import { guideActionState } from "./actionState"
import { GUIDE_STAGES } from "./lessons"

test("completed live actions remain usable after Back even if their run expired or has not hydrated", () => {
  const guide = { ...initialGuide(), step: 4, autoPaused: true, completed: ["issue.researched"] }
  for (const cards of [[], [card("completed")], [card("failed", 0, "Session expired")]]) {
    expect(guideActionState(GUIDE_STAGES[4]!.kind === "do" ? GUIDE_STAGES[4]!.actions[0]! : action, cards, guide))
      .toMatchObject({ label: "Run repro", key: "r", flow: "onboarding.act", args: "next" })
  }
})

test("advancing into another completed beat uses its receipt even after navigation clears the pause", () => {
  const lesson = GUIDE_STAGES[8]!
  if (lesson.kind !== "do") throw Error("expected file lesson")
  expect(guideActionState(lesson.actions[0]!, [], { ...initialGuide(), step: 8, autoPaused: false,
    completed: ["diff.opened", "diff.file.opened"] }))
    .toMatchObject({ flow: "onboarding.act", args: "next", key: "o" })
})

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


test("returning to a completed Change's picker advances without creating another live Change", () => {
  const completed = card("completed")
  if (completed.kind !== "run-trace") throw Error("run fixture")
  completed.payload.input = { liveTutorial: { operation: "change", playthrough: 0 } }
  const change = { label: "Make the Change", key: "g", flow: "change.open", args: "{picked}" }
  expect(guideActionState(change, [completed], { ...initialGuide(), step: 9, autoPaused: true, completed: ["change.opened"] }))
    .toMatchObject({ label: "Make the Change", key: "g", flow: "onboarding.act", args: "next" })
})
