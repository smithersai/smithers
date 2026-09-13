import { expect, test } from "bun:test"
import { traceFromJournal, turnNarratives } from "./RunTrace"
import { canCompleteTutorialTrace } from "../state/controller/tutorial2-turn_trace"
import { initialGuide } from "../state/AppState"

const record = (sequence: number, kind: string, payload: Record<string, unknown>) => ({ sequence, kind, payload })
const model = traceFromJournal({ runId: "change", flowId: "tutorial-change", status: "completed" }, [
  record(1, "control.agent.turn-opened", {}),
  record(2, "control.agent.model-settled", { text: "I read the file. More details follow." }),
  record(3, "control.agent.cell-produced", { text: "await ctx.call('files.read')" }),
  record(4, "control.agent.cell-call-started", { flowName: "files.read" }),
  record(5, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "failure", message: "Permission denied" }),
  record(6, "control.agent.turn-opened", {}),
  record(7, "control.agent.cell-call-started", { flowName: "target.run" }),
  record(8, "control.agent.turn-opened", {})
])
test("one grounded sentence per real turn, including calls-only and empty turns", () => {
  expect(turnNarratives(model).map(turn => turn.text)).toEqual([
    "I read the file.", "The agent called target.run.", "The turn started; no model response or flow calls have been recorded."
  ])
  expect(model.rows.find(row => row.id === "call-1")?.detail.message).toBe("Permission denied")
})
test("legacy trace inspection cannot complete the current diff-review lesson", () => {
  const guide = { ...initialGuide(), step: 7, playthrough: 3, completed: ["commits.made"] }
  const scope = { runId: "change", repo: "owner/repo", playthrough: 3 }
  const check = (g = guide, s: typeof scope | undefined = scope, active: string | null = scope.repo, run = scope.runId, node = "frame-1") =>
    canCompleteTutorialTrace(g, s, active, run, scope.repo, model, node)
  expect(check()).toBe(false)
  expect(check(guide, scope, scope.repo, scope.runId, "call-1")).toBe(false)
  expect(check({ ...guide, step: 6 })).toBe(false)
  expect(check({ ...guide, completed: [] })).toBe(false)
  expect(check({ ...guide, playthrough: 4 })).toBe(false)
  expect(check(guide, scope, "other/repo")).toBe(false)
  expect(check(guide, scope, null)).toBe(false)
  expect(check(guide, scope, scope.repo, "other-run")).toBe(false)
  for (const node of ["frame-2", "frame-3", "run:change", "invented"]) expect(check(guide, scope, scope.repo, scope.runId, node)).toBe(false)
  expect(canCompleteTutorialTrace(guide, undefined, scope.repo, scope.runId, scope.repo, model, "frame-1")).toBe(false)
})

test("structured redaction metadata never becomes recorded executable source", () => {
  const redacted = traceFromJournal({ runId: "r", flowId: "tutorial-change", status: "completed" }, [
    record(1, "control.agent.turn-opened", {}),
    record(2, "control.agent.cell-produced", { text: { truncated: true, digest: "hidden", bytes: 999 } }),
    record(3, "control.agent.cell-call-started", { flowName: "files.read" })
  ])
  expect(redacted.rows.find(row => row.kind === "cell")?.detail.source).toBeUndefined()
  expect(canCompleteTutorialTrace({ ...initialGuide(), step: 7, completed: ["commits.made"] },
    { runId: "r", repo: "owner/repo", playthrough: 0 }, "owner/repo", "r", "owner/repo", redacted, "frame-1")).toBe(false)
})
