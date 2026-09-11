/*
 * The run history card (docs/LOCAL-APP.md "Cards: target graph"): the repo's
 * recorded runs as a table — root label, status, started, duration, and the
 * summary's hit/ran/failed. Selecting a run dispatches its replay: a
 * timeline card fed from /api/targets/runs/replay with a scrubber that
 * replays events up to the cursor into the timeline and the graph overlay.
 */
import { Button, EmptyState, StatusPill } from "@smthrs/ui"
import { durationLabel, timeLabel } from "../Timestamps"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"

export const RunHistoryCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "run-history" }>
  readonly onRunCommand: RunCommand
}) => {
  const { repoId, status, runs, selected, error } = card.payload
  if (status === "pending") return <p className="smithers-card-note">Loading run history…</p>
  if (status === "failed") {
    return (
      <p className="sui-approval-error" role="alert">
        {error ?? "The run history did not load."}
      </p>
    )
  }
  if (runs.length === 0) return <EmptyState description="No runs recorded for this repository yet." />
  return (
    <table className="run-history-table" aria-label="Recorded target runs" data-testid={`run-history-${repoId}`}>
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Status</th>
          <th scope="col">Started</th>
          <th scope="col">Duration</th>
          <th scope="col">hit / ran / failed</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.runId} data-run-row={run.runId} data-selected={selected === run.runId}>
            <td>
              <Button
                variant="ghost"
                size="sm"
                className="run-history-select"
                data-flow="target.runs.select"
                aria-pressed={selected === run.runId}
                onClick={() => onRunCommand("target.runs.select", `${repoId} ${run.runId}`)}
              >
                {run.label}
              </Button>
            </td>
            <td>
              <StatusPill status={run.status} />
            </td>
            <td>{timeLabel(run.startedAt)}</td>
            <td>{run.endedAt !== undefined ? durationLabel(run.endedAt - run.startedAt) : "—"}</td>
            <td>
              {run.summary !== undefined ? `${run.summary.hit} / ${run.summary.ran} / ${run.summary.failed}` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export const runHistoryCardFamily: CardFamily<"run-history"> = {
  "run-history": {
    render: (card, actions) => <RunHistoryCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: (card) => card.payload.status
  }
}
