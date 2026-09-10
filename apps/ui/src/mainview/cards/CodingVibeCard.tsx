import type { Card } from "../state/AppState"
import { runSourceCommand } from "../flows/RunCommand"
import type { RunCommand } from "./CardFamily"
import { codingVibeProgressOf } from "./CodingVibe"

/** The same native child debugger explains each finalization receipt. */
export const CodingVibeBody = ({ card, onRunCommand: send }: {
  readonly card: Extract<Card, { kind: "run-trace" }>
  readonly onRunCommand: RunCommand
}) => {
  const progress = codingVibeProgressOf(card)
  if (progress === undefined) return null
  const onRunCommand = runSourceCommand(card.id, send)
  return <section className="coding-plan" aria-label="Coding finalization">
    <p>{progress.stage === "cleaned" ? "History descriptions cleaned and checks revalidated." : "Validated request admitted for cleanup."}</p>
    {progress.summary === undefined ? null : <p>{progress.summary.length <= 240 ? progress.summary : `${progress.summary.slice(0, 240)}…`}</p>}
    <button type="button" className="run-trace-filter" data-flow="runs.trace.select"
      onClick={() => onRunCommand("runs.trace.select", `${card.payload.runId} ${progress.spanId}`)}>
      {progress.stage === "cleaned" ? "Inspect cleanup receipt" : "Inspect admission receipt"}
    </button>
  </section>
}
