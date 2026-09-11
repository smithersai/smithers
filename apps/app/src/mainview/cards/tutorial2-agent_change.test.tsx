import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CodingPlanBody } from "./CodingPlanCard"
import { CODING_PLAN } from "./fixtures/CodingPlan"
import type { Card } from "../state/AppState"
const card: Extract<Card, { kind: "run-trace" }> = { id: "plan", kind: "run-trace", title: "Plan", status: "active", createdAt: 0, ordinal: 1,
  payload: { repo: "o/r", runId: "plan", workflow: "tutorial-change", kind: "change-plan", phase: "completed", steps: [], result: null, lastSeq: 0,
    input: { plan: { ...CODING_PLAN, changes: [CODING_PLAN.changes[0]!] } } } }
test("review shows actual plan and keyboard-native start door before any commit strip", () => {
  const html = renderToStaticMarkup(<CodingPlanBody card={card} onRunCommand={() => {}} />)
  expect(html).toContain(CODING_PLAN.base.commitId)
  expect(html).toContain('aria-label="Planned commits"')
  expect(html).toContain('data-flow="agent.change.start"')
  expect(html).toContain('type="button"')
  expect(html).not.toContain('aria-label="Resulting commit"')
})
