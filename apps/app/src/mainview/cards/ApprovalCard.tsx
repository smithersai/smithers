/*
 * The approval card: a capability the run asked the human to allow. The
 * decision rides onDecideApproval; the stamp says what was decided and when.
 */
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest
} from "@smthrs/ui"
import type { ApprovalState } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { timeLabel as clockLabel } from "../Timestamps"
import type { CardFamily } from "./CardFamily"

const ApprovalCardBody = ({
  card,
  onDecideApproval
}: {
  readonly card: Extract<Card, { kind: "approval" }>
  readonly onDecideApproval: (id: string, decision: "approved" | "denied") => void
}) => {
  const payload = card.payload
  const pending = payload.pending === true
  const state: ApprovalState = card.status === "error"
    ? "failed-submission"
    : card.status === "acted"
    ? (payload.decision ?? "approved")
    : "requested"
  const summary = card.body ?? payload.detail
  const stamp = payload.decidedAt !== undefined
    ? `${payload.decision === "denied" ? "Denied" : "Approved"} — ${clockLabel(payload.decidedAt)}`
    : undefined
  return (
    <Confirmation state={state}>
      <ConfirmationRequest>
        {summary !== undefined ? <div className="sui-approval-summary">{summary}</div> : null}
        <ul className="sui-approval-actions-list">
          <li>{payload.capability}</li>
        </ul>
      </ConfirmationRequest>
      {pending ? <p className="sui-approval-pending">Sending your decision…</p> : (
        <ConfirmationActions>
          <ConfirmationAction
            decision="approve"
            onDecide={() => onDecideApproval(card.id, "approved")}
          />
          <ConfirmationAction
            decision="deny"
            onDecide={() => onDecideApproval(card.id, "denied")}
          />
        </ConfirmationActions>
      )}
      {card.status === "error" && payload.error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {payload.error}
          </p>
        ) :
        null}
      <ConfirmationAccepted>{stamp}</ConfirmationAccepted>
      <ConfirmationRejected>{stamp}</ConfirmationRejected>
    </Confirmation>
  )
}


export const approvalCardFamily: CardFamily<"approval"> = {
  approval: {
    render: (card, actions) => <ApprovalCardBody card={card} onDecideApproval={actions.onDecideApproval} />,
    pill: (card) => {
      if (card.status === "acted") return card.payload.decision ?? "approved"
      return "waiting-approval"
    }
  }
}
