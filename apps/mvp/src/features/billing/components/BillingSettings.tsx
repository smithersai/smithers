import { Badge, Button, Field, Input, Label, RelativeTime } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useLocation } from "@tanstack/react-router"
import type { FormEvent } from "react"
import { COMPUTE_PACKS, formatUsd } from "../contract"
import { useBillingOptional } from "./BillingContext"
import "./billing.css"

const CHECKOUT_ERROR_COPY: Readonly<Record<string, string>> = {
  not_configured: "Stripe checkout isn't configured on this deployment yet.",
  person_only: "Only a signed-in person can purchase compute credits.",
  unavailable: "Couldn't start checkout. Try again.",
}

export function BillingSettings({ admin }: { readonly admin: boolean }) {
  const billing = useBillingOptional()
  if (billing === null) return null
  return <BillingSettingsInner billing={billing} admin={admin} />
}

function BillingSettingsInner({
  billing,
  admin,
}: {
  readonly billing: NonNullable<ReturnType<typeof useBillingOptional>>
  readonly admin: boolean
}) {
  const { queries, actions } = billing
  const { data: state } = useLiveQuery(queries.state)
  const location = useLocation()
  const searchParams = new URLSearchParams(location.searchStr)
  const billingFlag = searchParams.get("billing")
  const account = state?.account ?? null
  const loading = state?.status === "loading"
  const checkoutPackId = state?.checkoutPackId ?? null
  const checkoutError = state?.checkoutError ?? null

  const badge =
    account?.computeAccess === "deployment"
      ? { label: "Included (maintainer)", variant: "success" as const }
      : account?.computeAccess === "paid"
      ? { label: "Cloud sandboxes active", variant: "success" as const }
      : { label: "BYOA free · Add credits for cloud", variant: "muted" as const }

  const standardRate = account?.rates.find((r) => r.instance === account.defaultInstance)

  const submitGrant = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const login = String(form.get("login") ?? "").trim()
    const amountUsd = Number(form.get("amountUsd") ?? 0)
    const note = String(form.get("note") ?? "").trim()
    if (login === "" || !Number.isFinite(amountUsd) || amountUsd <= 0) return
    void actions.grant({ login, amountUsd, note })
  }

  return (
    <section id="billing" className="billing-settings" aria-label="Cloud compute credits">
      <div className="billing-settings-head">
        <h2>Cloud compute &amp; credits</h2>
        <div style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}>
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void actions.load()}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {billingFlag === "success" ? (
        <p className="billing-note" role="status">Payment received — credits apply automatically within seconds.</p>
      ) : billingFlag === "canceled" ? (
        <p className="billing-note" role="status">Checkout canceled. No charge was made.</p>
      ) : null}

      <div className="billing-balance-row">
        <div>
          <span className="billing-balance-amount">
            {account === null ? "—" : formatUsd(account.balanceMicroUsd)}
          </span>
          {account !== null && account.lifetimeSpentMicroUsd > 0 ? (
            <span className="billing-note" style={{ marginLeft: "0.75rem" }}>
              Spent {formatUsd(account.lifetimeSpentMicroUsd)}
            </span>
          ) : null}
        </div>
        <div className="billing-rates">
          <span>
            {standardRate !== undefined
              ? `${standardRate.instance} (${standardRate.vcpu} vCPU · ${standardRate.memoryGib} GiB): ~$${standardRate.hourlyUsd.toFixed(2)}/hr`
              : "standard-1: ~$0.15/hr"}
          </span>
          <span>· Hard cap at $0</span>
        </div>
      </div>

      <div className="billing-packs" aria-label="Top up compute credits">
        {(account?.packs ?? COMPUTE_PACKS).map((pack) => (
          <Button
            key={pack.id}
            size="sm"
            variant="solid"
            disabled={checkoutPackId !== null || (account !== null && !account.stripeConfigured)}
            onClick={() => void actions.checkout(pack.id)}
          >
            {checkoutPackId === pack.id ? "Opening checkout…" : `Add ${pack.label}`}
          </Button>
        ))}
        {account !== null && !account.stripeConfigured ? (
          <span className="billing-note" role="status">Stripe checkout isn't configured on this deployment yet.</span>
        ) : null}
      </div>

      {checkoutError !== null ? (
        <p className="billing-note" role="status">{CHECKOUT_ERROR_COPY[checkoutError] ?? `Checkout error (${checkoutError}).`}</p>
      ) : null}

      <p className="billing-note">
        Free alternative: attach your own agent locally via MCP (<code>smthrs node serve</code>) above — no cloud credits needed.
      </p>

      {account !== null && account.ledger.length > 0 ? (
        <ul className="billing-ledger" aria-label="Compute ledger">
          {account.ledger.slice(0, 10).map((entry) => (
            <li key={entry.id} className="billing-ledger-row">
              <span>
                {entry.description}
                {" · "}
                <RelativeTime ts={Date.parse(entry.createdAt)} />
              </span>
              <span>
                <strong>{entry.amountMicroUsd >= 0 ? `+${formatUsd(entry.amountMicroUsd)}` : formatUsd(entry.amountMicroUsd)}</strong>
                {" "}
                <span className="billing-note">({formatUsd(entry.balanceAfterMicroUsd)})</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {admin ? (
        <form className="billing-grant-form" aria-label="Grant compute credits" onSubmit={submitGrant}>
          <Field>
            <Label htmlFor="billing-grant-login">GitHub login</Label>
            <Input id="billing-grant-login" name="login" placeholder="octocat" required autoComplete="off" />
          </Field>
          <Field>
            <Label htmlFor="billing-grant-usd">Amount (USD)</Label>
            <Input id="billing-grant-usd" name="amountUsd" type="number" min={1} max={1000} step={1} defaultValue={10} required />
          </Field>
          <Field>
            <Label htmlFor="billing-grant-note">Note</Label>
            <Input id="billing-grant-note" name="note" placeholder="Contributor grant" autoComplete="off" />
          </Field>
          <Button size="sm" type="submit" disabled={state?.grantSaving === true}>
            {state?.grantSaving === true ? "Granting…" : "Grant credits"}
          </Button>
          {state?.grantStatus ? <span className="billing-note" role="status">{state.grantStatus}</span> : null}
        </form>
      ) : null}
    </section>
  )
}
