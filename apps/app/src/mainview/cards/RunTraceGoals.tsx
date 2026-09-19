import type { RunCommand } from "./CardFamily"
import { flowAction } from "../flows/FlowAction"
import type { GoalState, TraceGoal } from "./RunTraceStatus"

export const GOAL_STATE_WORDS: Readonly<Record<GoalState, string>> = {
  pending: "Pending", running: "Checking", passed: "Verified", failed: "Failed", narrowed: "Partial check", stale: "Needs recheck"
}

/** Check results advance recorded goals; opening one uses the existing plan selection. */
export const RunTraceGoals = ({ goals, runId, selected, detailsId, onRunCommand }: {
  readonly goals: ReadonlyArray<TraceGoal>
  readonly runId: string
  readonly selected?: string
  readonly detailsId: string
  readonly onRunCommand: RunCommand
}) => <ol className="run-goals" aria-label="Goals">
  {goals.map(goal => <li key={goal.id} data-goal={goal.id} data-state={goal.state}>
    <button type="button" className="run-goal" aria-expanded={selected === goal.id}
      aria-controls={selected === goal.id ? detailsId : undefined}
      {...flowAction(onRunCommand, "runs.coding.select", `${runId} ${goal.id}`)}>
      <span aria-hidden>{goal.state === "passed" ? "✓" : goal.state === "failed" ? "×" : "○"}</span>
      <span className="run-goal-title">{goal.title}</span>
      <span className="run-goal-state">{GOAL_STATE_WORDS[goal.state]}</span>
    </button>
  </li>)}
</ol>
