/*
 * The admin cards: the access-request queue and the service health readout.
 * Both exist once their read has settled, so they wear "done" (§28.3): a read
 * that hung must not look like one that rendered everything.
 */
import { Button, StatusPill } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { dateLabel, dayLabel } from "../Timestamps"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

const RequestQueueCardBody = ({
  card,
  onQueueApprove
}: {
  readonly card: Extract<Card, { kind: "request-queue" }>
  readonly onQueueApprove: (login: string) => void
}) => {
  const { requests, approving, error } = card.payload
  if (requests.length === 0) {
    return <p className="smithers-card-note">The queue is empty — nobody is waiting.</p>
  }
  return (
    <div className="queue-card">
      <ul className="queue-list">
        {requests.map((entry) => (
          <li key={entry.login} className="queue-row">
            <span className="queue-login">{entry.login}</span>
            {entry.note !== null ? <span className="queue-note">{entry.note}</span> : null}
            <span className="queue-at">{dayLabel(entry.createdAt)}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={approving !== null}
              onClick={() => onQueueApprove(entry.login)}
            >
              {approving === entry.login ? "Approving…" : "Approve"}
            </Button>
          </li>
        ))}
      </ul>
      {error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
    </div>
  )
}

const AdminHealthCardBody = ({ card }: { readonly card: Extract<Card, { kind: "admin-health" }> }) => {
  const { services, queueDepth, charges, checkedAt } = card.payload
  return (
    <div className="admin-health">
      <ul className="admin-health-services">
        {services.map((service) => (
          <li key={service.name} data-status={service.status}>
            <StatusPill
              status={service.status === "ok" ? "done" : service.status === "failed" ? "failed" : "pending"}
            />{" "}
            <strong>{service.name}</strong> — {service.detail}
          </li>
        ))}
      </ul>
      <p className="smithers-card-note">
        {queueDepth === null
          ? "Request queue depth: unread."
          : `Request queue: ${queueDepth} waiting.`} {charges === null
          ? "Charges: unread."
          : `Charges: $${charges.lifetimeChargedUsd} across ${charges.chargeCount} turn${
            charges.chargeCount === 1 ? "" : "s"
          }.`} Read at {dateLabel(checkedAt)}.
      </p>
    </div>
  )
}


export const adminCardFamily: CardFamily<"request-queue" | "admin-health"> = {
  "request-queue": {
    render: (card, actions) => <RequestQueueCardBody card={card} onQueueApprove={actions.onQueueApprove} />,
    pill: settledPill
  },
  "admin-health": {
    render: (card) => <AdminHealthCardBody card={card} />,
    pill: settledPill
  }
}
