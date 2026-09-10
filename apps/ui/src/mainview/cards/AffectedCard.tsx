/*
 * The affected card (docs/LOCAL-APP.md "Cards: target graph"): the working
 * tree's changed files and the labels they re-key, each with its reason and
 * a "show in graph" act that focuses the label in the repository's graph
 * card.
 */
import { Button, EmptyState } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"

export const AffectedCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "affected" }>
  readonly onRunCommand: RunCommand
}) => {
  const { repoId, status, result, error } = card.payload
  if (status === "pending") return <p className="smithers-card-note">Computing the affected set…</p>
  if (status === "failed" || result === undefined) {
    return (
      <p className="sui-approval-error" role="alert">
        {error ?? "The affected set did not load."}
      </p>
    )
  }
  return (
    <div className="affected-card" data-testid={`affected-card-${repoId}`}>
      <p className="smithers-card-note">
        Against {result.base} — {result.changedFiles.length} changed file{result.changedFiles.length === 1 ? "" : "s"},
        {" "}{result.affected.length} affected target{result.affected.length === 1 ? "" : "s"}.
      </p>
      {result.changedFiles.length === 0 ?
        <EmptyState description="The working tree is clean — nothing re-keys." /> :
        (
          <>
            <ul className="affected-card-files" aria-label="Changed files">
              {result.changedFiles.map((file) => (
                <li key={file}>
                  <code className="graph-drawer-mono">{file}</code>
                </li>
              ))}
            </ul>
            <ul className="affected-card-labels" aria-label="Affected targets">
              {result.affected.map((entry) => (
                <li key={entry.label} className="affected-card-row" data-affected-row={entry.label}>
                  <span className="targets-card-label">{entry.label}</span>
                  <span className="affected-card-reason">{entry.reason}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-flow="target.graph"
                    onClick={() => onRunCommand("target.graph", `${repoId} ${entry.label}`)}
                  >
                    Show in graph
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
    </div>
  )
}

/* The target-graph cards' payloads carry their own read status. */
export const affectedCardFamily: CardFamily<"affected"> = {
  affected: {
    render: (card, actions) => <AffectedCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: (card) => card.payload.status
  }
}
