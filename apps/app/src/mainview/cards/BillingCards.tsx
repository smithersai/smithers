import { timeLabel } from "../Timestamps"
import { flowAction } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import { refusalFromStored } from "@smthrs/rpc/Refusal"
import { refusalLead } from "@smthrs/rpc/RefusalCopy"
import { useCallback, useSyncExternalStore } from "react"
import { creditDollars } from "../state/seams/BillingSeam"
import { UpgradeDoor } from "./WorkspaceCard"
import type { CardProjectionAuthority, RunCommand } from "./CardFamily"

/*
 * The billing cards: the balance readout and the admin's promotional grant
 * confirm. Money moves only through the billing service; the cards report.
 */
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

const quantity = (value: number) => value === -1 ? "Unlimited" : String(value)
const idle = (seconds: number) => seconds === 0 ? "Never sleeps" : seconds < 3600 ? `${seconds / 60} min` : `${seconds / 3600} h`

type BillingPlansCard = Extract<Card, { kind: "billing-plans" }>

export const BillingPlansCardBody = ({ card, onRunCommand, creditBalanceCents = null }: {
  readonly card: BillingPlansCard; readonly onRunCommand: RunCommand; readonly creditBalanceCents?: number | null
}) => {
  const { plans, planKey, sandbox, checkout } = card.payload
  const refusal = card.payload.refusal ? refusalFromStored(card.payload.refusal) : null
  const columns = [...plans].sort((a, b) => a.price_cents - b.price_cents)
  return <div className="world-card-list">
    {refusal === null ? null : <div role="alert">
      <p>{refusalLead(refusal)}</p><p>{refusal.message}</p>
      <UpgradeDoor refusal={refusal} onRunCommand={onRunCommand} disabled={!checkout || plans.find(plan => plan.key === refusal.upgrade_plan_key)?.checkout_available === false} />
    </div>}
    {!checkout ? <p>Checkout is not open yet.</p> : null}
    {columns.length === 0 ? null : <div style={{ overflowX: "auto" }}><table>
      <thead><tr><th scope="col">Plan</th>{columns.map(plan => <th scope="col" key={plan.key}
        aria-current={plan.key === planKey ? "true" : undefined}
        style={plan.key === planKey ? { background: "var(--surface)", outline: "2px solid currentColor", outlineOffset: "-2px" } : undefined}>
        {plan.display_name} {dollars.format(plan.price_cents / 100)}{plan.price_cents === 0 ? "" : " per month"}
        {plan.key === planKey ? " · Current plan" : ""}
        {plan.key === planKey && creditBalanceCents !== null ? <> · <span data-testid="billing-credit">{creditDollars(creditBalanceCents)}</span></> : null}
      </th>)}</tr></thead>
      <tbody>
        <tr><th scope="row">Running sandboxes</th>{columns.map(plan => <td key={plan.key}>{quantity(plan.limits.concurrent_sandboxes)}</td>)}</tr>
        <tr><th scope="row">Idle sleep</th>{columns.map(plan => <td key={plan.key}>{idle(plan.limits.idle_timeout_secs)}</td>)}</tr>
        <tr><th scope="row">Sandbox-hours per day</th>{columns.map(plan => <td key={plan.key}>{quantity(plan.limits.hours_per_day)}</td>)}</tr>
        <tr><th scope="row">Upgrade</th>{columns.map(plan => <td key={plan.key}>{plan.key === "free" ? null :
          <Button size="sm" disabled={!checkout || !plan.checkout_available || plan.key === planKey}
            {...flowAction(onRunCommand, "billing.upgrade", flowArgs("billing.upgrade", { plan: plan.key }))}>
            Upgrade to {plan.display_name}
          </Button>}
        </td>)}</tr>
      </tbody>
    </table></div>}
    {sandbox === null ? null : <p>
      In use: {sandbox.concurrentInUse} / {quantity(sandbox.concurrentSandboxes)} · Hours today: {Number((sandbox.secondsUsedToday / 3600).toFixed(2))} / {quantity(sandbox.hoursPerDay)} · Resets at <time dateTime={sandbox.dayResetsAt}>{timeLabel(Date.parse(sandbox.dayResetsAt))}</time>
    </p>}
  </div>
}

/** The account's credit is the billing row's live fact, read beside the card's plans. */
const ObservedBillingPlans = ({ card, accounts, onRunCommand }: {
  readonly card: BillingPlansCard; readonly onRunCommand: RunCommand
  readonly accounts: NonNullable<CardProjectionAuthority["collections"]["billingAccounts"]>
}) => {
  const subscribe = useCallback((notify: () => void) => {
    const subscription = accounts.subscribeChanges(notify)
    return () => subscription.unsubscribe()
  }, [accounts])
  const read = () => accounts.get("billing")?.creditBalanceCents ?? null
  return <BillingPlansCardBody card={card} onRunCommand={onRunCommand} creditBalanceCents={useSyncExternalStore(subscribe, read, read)} />
}

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


export const billingCardFamily: CardFamily<"balance" | "grant-confirm" | "billing-plans"> = {
  "billing-plans": {
    render: (card, actions) => actions.projectionStore?.collections.billingAccounts === undefined
      ? <BillingPlansCardBody card={card} onRunCommand={actions.onRunCommand} />
      : <ObservedBillingPlans card={card} accounts={actions.projectionStore.collections.billingAccounts} onRunCommand={actions.onRunCommand} />,
    pill: () => "done"
  },
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
