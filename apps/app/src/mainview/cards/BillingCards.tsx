/*
 * The billing cards: the balance readout and the admin's promotional grant
 * confirm. Money moves only through the billing service; the cards report.
 */
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"

const BalanceCardBody = ({ card }: { readonly card: Extract<Card, { kind: "balance" }> }) => (
  <>
    {card.payload.introUsd !== null ?
      <p className="smithers-balance-intro">You have ${card.payload.introUsd} of usage on us.</p> :
      null}
    <p className="smithers-balance-total">
      {card.payload.allowedToStartWork
        ? `$${card.payload.totalUsd} left.`
        : "Balance is at $0 — new work is paused; everything already here stays readable."}
    </p>
    {card.payload.chargeCount > 0 ?
      (
        <p className="smithers-card-note">
          ${card.payload.lifetimeChargedUsd} spent across {card.payload.chargeCount} turn
          {card.payload.chargeCount === 1 ? "" : "s"} so far.
        </p>
      ) :
      null}
  </>
)


const GrantConfirmCardBody = ({
  card,
  onGrantConfirm,
  onGrantCancel
}: {
  readonly card: Extract<Card, { kind: "grant-confirm" }>
  readonly onGrantConfirm: (id: string) => void
  readonly onGrantCancel: (id: string) => void
}) => {
  const { login, amountUsd, phase, grantId, error } = card.payload
  return (
    <div className="grant-card">
      <p className="grant-what">
        Grant <strong>${amountUsd}</strong> of promotional balance to <strong>{login}</strong>.
      </p>
      <p className="smithers-card-note">
        The grant is recorded with your login as the requester and a fresh timestamp; the billing service answers before
        anything is treated as done.
      </p>
      {phase === "confirm" || phase === "failed" ?
        (
          <div className="reco-actions">
            <Button size="sm" onClick={() => onGrantConfirm(card.id)}>
              {phase === "failed" ? "Try again" : "Post the grant"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onGrantCancel(card.id)}>
              Cancel
            </Button>
          </div>
        ) :
        null}
      {phase === "sending" ? <p className="sui-approval-pending">Posting the grant…</p> : null}
      {phase === "granted" ?
        (
          <p className="smithers-card-note">
            Granted{grantId !== undefined ? ` — ${grantId}` : ""}.
          </p>
        ) :
        null}
      {phase === "failed" && error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
    </div>
  )
}


export const billingCardFamily: CardFamily<"balance" | "grant-confirm"> = {
  balance: {
    render: (card) => <BalanceCardBody card={card} />,
    pill: (card) => {
      if (card.payload.state === "empty") return "failed"
      if (card.payload.state === "low") return "pending"
      return "done"
    }
  },
  "grant-confirm": {
    render: (card, actions) => (
      <GrantConfirmCardBody card={card} onGrantConfirm={actions.onGrantConfirm} onGrantCancel={actions.onGrantCancel} />
    ),
    pill: (card) => {
      if (card.payload.phase === "granted") return "done"
      if (card.payload.phase === "sending") return "running"
      return "waiting-approval"
    }
  }
}
