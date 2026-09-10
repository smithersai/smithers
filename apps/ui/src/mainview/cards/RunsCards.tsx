/*
 * Lane runs — the run inbox and the approvals inbox cards.
 *
 * The run inbox (runs.list) rows one summary per run on the workspace; a
 * row's only act is Open, which materializes the run's own card — the acts
 * (resume, steer, stop) live on that card, so there is one run surface, not
 * two. The approvals inbox (approvals.list) carries each pending gate with
 * the submit-ready envelope the gateway published; a decision dispatches the
 * same approval.approve / approval.deny flows a per-run approval card uses,
 * addressed `inboxCardId:requestId`.
 */
import { Button, Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { timeLabel as clockLabel } from "../Timestamps"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

/** Why a run is not moving, in words: the control plane's reason, translated. */
const waitingWords = (waiting: string): string =>
  waiting === "executor" ? "accepted · nothing is driving it" : `waiting · ${waiting}`

/** The statuses a run can still be stopped in. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["accepted", "running", "parked", "waiting-approval"])

export const RunListCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "run-list" }>
  readonly onRunCommand: RunCommand
}) => {
  const { repo, runs } = card.payload
  /*
   * The header's mono count line: one clause per status present, in the
   * order a reader triages — live first, settled last.
   */
  const countByStatus = new Map<string, number>()
  for (const run of runs) countByStatus.set(run.status, (countByStatus.get(run.status) ?? 0) + 1)
  const countLine = [...countByStatus.entries()]
    .sort(([left], [right]) => Number(LIVE_STATUSES.has(right)) - Number(LIVE_STATUSES.has(left)) || left.localeCompare(right))
    .map(([status, count]) => `${count} ${status}`)
    .join(" · ")
  /* The filter chips: every status the unfiltered workspace could carry, each re-invoking runs.list with its argument. */
  const chips = [...new Set([...(card.payload.statuses ?? []), ...runs.map((run) => run.status)])].sort()
  const listArgs = (status?: string): string =>
    [status, card.payload.flow, card.payload.lineage === undefined ? undefined : `lineage=${card.payload.lineage}`, `sourceCard=${card.id}`, repo]
      .filter((part) => part !== undefined)
      .join(" ")
  const liveCount = runs.filter((run) => LIVE_STATUSES.has(run.status)).length
  return (
    <div className="world-card-list">
      <p className="smithers-card-note" data-testid="run-list-counts">
        {runs.length === 0 ? "No runs match." : `${runs.length} ${runs.length === 1 ? "run" : "runs"} · ${countLine}`}
      </p>
      {chips.length > 1 ?
        (
          <div className="flow-run-actions" role="group" aria-label="Filter by status">
            <Button
              size="sm"
              variant={card.payload.status === undefined ? "default" : "outline"}
              data-flow="runs.list"
              onClick={() => onRunCommand("runs.list", listArgs())}
            >
              All
            </Button>
            {chips.map((status) => (
              <Button
                key={status}
                size="sm"
                variant={card.payload.status === status ? "default" : "outline"}
                data-flow="runs.list"
                data-testid={`run-list-chip-${status}`}
                onClick={() => onRunCommand("runs.list", listArgs(status))}
              >
                {status}
              </Button>
            ))}
          </div>
        ) :
        null}
      {runs.length === 0 ?
        null :
        (
          <ul className="world-card-list">
            {runs.map((run) => (
              <li key={run.runId} className="world-card-row" data-status={run.status}>
                <span className="world-card-path">{run.runId}</span>
                <span className="world-card-title">{run.flowId}</span>
                <span className="world-card-path">
                  {run.waiting === undefined ? run.status : waitingWords(run.waiting)}
                </span>
                <span className="world-card-path">
                  {run.turns} {run.turns === 1 ? "turn" : "turns"} · {run.calls} {run.calls === 1 ? "call" : "calls"}
                </span>
                <span className="world-card-path">{clockLabel(run.createdAt)}</span>
                <Button
                  size="sm"
                  variant="outline"
                  data-flow="runs.open"
                  data-testid={`runs-open-${run.runId}`}
                  onClick={() => onRunCommand("runs.open", `sourceCard=${card.id} ${run.runId}`)}
                >
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      {liveCount > 0 ?
        (
          <div className="flow-run-actions">
            <Button
              size="sm"
              variant="outline"
              data-flow="flow.run.stop-all"
              data-testid="run-list-stop-all"
              onClick={() => onRunCommand("flow.run.stop-all", `sourceCard=${card.id} ${repo}`)}
            >
              Stop all {liveCount}
            </Button>
          </div>
        ) :
        null}
    </div>
  )
}

export const ApprovalsInboxCardBody = ({
  card,
  onDecideApproval
}: {
  readonly card: Extract<Card, { kind: "approvals-inbox" }>
  readonly onDecideApproval: (id: string, decision: "approved" | "denied") => void
}) => {
  const { repo, approvals } = card.payload
  if (approvals.length === 0) {
    return <p className="smithers-card-note">No approvals are pending on {repo}.</p>
  }
  return (
    <div className="world-card-list">
      <p className="smithers-card-note" data-testid="approvals-inbox-count">
        {approvals.length} approval{approvals.length === 1 ? "" : "s"} pending on {repo}
      </p>
      {approvals.map((approval) => {
        // The row id the decision flows take: the inbox card plus the gate it names.
        const rowId = `${card.id}:${approval.requestId}`
        const state = approval.decisionError !== undefined
          ? "failed-submission"
          : approval.decision ?? "requested"
        // The stamp states WHEN the decision was made, never when the gate was
        // raised; a row that has no decision time says only what it decided.
        const stamp = approval.decidedAt === undefined
          ? undefined
          : `${approval.decision === "denied" ? "Denied" : "Approved"} — ${clockLabel(approval.decidedAt)}`
        return (
          <Confirmation key={approval.requestId} state={state}>
            <ConfirmationRequest>
              <div className="sui-approval-summary">{approval.title}</div>
              <ul className="sui-approval-actions-list">
                <li>run {approval.runId} · {clockLabel(approval.requestedAt)}</li>
              </ul>
            </ConfirmationRequest>
            {approval.decision === undefined && approval.pending !== true ?
              (
                <ConfirmationActions>
                  <ConfirmationAction
                    decision="approve"
                    onDecide={() => onDecideApproval(rowId, "approved")}
                  />
                  <ConfirmationAction
                    decision="deny"
                    onDecide={() => onDecideApproval(rowId, "denied")}
                  />
                </ConfirmationActions>
              ) :
              null}
            {approval.decisionError !== undefined ?
              (
                <p className="sui-approval-error" role="alert">
                  {approval.decisionError}
                </p>
              ) :
              null}
            <ConfirmationAccepted>{stamp}</ConfirmationAccepted>
            <ConfirmationRejected>{stamp}</ConfirmationRejected>
          </Confirmation>
        )
      })}
    </div>
  )
}

/* Lane runs: the inboxes are listings; they settle the moment they render. */
export const runsCardFamily: CardFamily<"run-list" | "approvals-inbox"> = {
  "run-list": {
    render: (card, actions) => <RunListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  "approvals-inbox": {
    render: (card, actions) => <ApprovalsInboxCardBody card={card} onDecideApproval={actions.onDecideApproval} />,
    pill: settledPill
  }
}
