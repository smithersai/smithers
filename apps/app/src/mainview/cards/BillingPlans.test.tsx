import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { CardSchema } from "@smthrs/rpc/Cards"
import { createBillingSeam, creditDollars } from "../state/seams/BillingSeam"
import { createAppStore } from "../state/AppStore"
import type { Card } from "../state/AppState"
import { BillingPlansCardBody } from "./BillingCards"

GlobalRegistrator.register()
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const plans = [
  { key: "free", display_name: "Free", price_cents: 0, concurrent: 1, idle: 1800, hours: 4 },
  { key: "pro", display_name: "Pro", price_cents: 1950, concurrent: 3, idle: 14400, hours: -1 },
  { key: "max", display_name: "Max", price_cents: 50000, concurrent: 20, idle: 0, hours: -1 }
].map(p => ({ ...p, interval: "monthly", checkout_available: p.key !== "free", limits: {
  concurrent_sandboxes: p.concurrent, idle_timeout_secs: p.idle, hours_per_day: p.hours,
  private_repos: -1, storage_bytes: -1, ci_minutes: -1, agent_runs: -1, seats: 1
} }))
const fixture = (checkout = true): Extract<Card, { kind: "billing-plans" }> => CardSchema.parse({
  id: "billing-plans", kind: "billing-plans", title: "Plans", status: "active", ordinal: 0, createdAt: 0,
  payload: { planKey: "free", plans, checkout, sandbox: {
    concurrentSandboxes: 1, concurrentInUse: 1, idleTimeoutSecs: 1800,
    hoursPerDay: 4, secondsUsedToday: 5400, dayResetsAt: "2026-09-16T00:00:00Z"
  } }
}) as Extract<Card, { kind: "billing-plans" }>
const render = (card = fixture(), creditBalanceCents: number | null = null) => {
  const host = document.createElement("div")
  const calls: unknown[] = []
  const root = createRoot(host)
  flushSync(() => root.render(<BillingPlansCardBody card={card} creditBalanceCents={creditBalanceCents} onRunCommand={(...args) => { calls.push(args) }} />))
  return { host, calls, close: () => flushSync(() => root.unmount()) }
}
test("fixture renders plan columns, current plan, usage, and typed paid-plan buttons", () => {
  const { host, calls, close } = render()
  expect(host.textContent).toContain("Free $0")
  expect(host.textContent).toContain("Pro $19.50 per month")
  expect(host.textContent).toContain("Max $500.00 per month")
  expect(host.querySelector('[aria-current="true"]')?.textContent).toContain("Free")
  expect(host.textContent).toContain("Never sleeps")
  expect(host.textContent).toContain("Hours today: 1.5 / 4")
  const reset = host.querySelector("time")
  expect(reset?.dateTime).toBe("2026-09-16T00:00:00Z")
  expect(reset?.textContent).not.toContain("2026-09-16T00:00:00Z")
  expect(reset?.textContent).toMatch(/\d{1,2}:\d{2}/)
  const buttons = host.querySelectorAll<HTMLButtonElement>('button[data-flow="billing.upgrade"]')
  buttons[0]!.click(); buttons[1]!.click()
  expect(calls).toEqual([["billing.upgrade", "pro"], ["billing.upgrade", "max"]])
  close()
})
test("closed checkout explains availability and disables upgrade buttons", () => {
  const { host, calls, close } = render(fixture(false))
  expect(host.textContent).toContain("Checkout is not open yet.")
  for (const button of host.querySelectorAll<HTMLButtonElement>("button")) { expect(button.disabled).toBe(true); button.click() }
  expect(calls).toEqual([])
  close()
})
test("upgrade refusal door preserves the backend's target plan", () => {
  const card = fixture()
  card.payload.refusal = { status: 402, code: "plan_limit_exceeded", message: "Daily hours exhausted.", plan_key: "pro", limit_kind: "sandbox_hours_per_day", upgrade_plan_key: "max" }
  const { host, calls, close } = render(card)
  expect(host.textContent).toContain("Your plan is at its sandbox limit.")
  host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
  expect(calls).toEqual([["billing.upgrade", "max"]])
  close()
})
test("billing read loads both endpoints and dispatches the account and embedded card", async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) }
  } })
  const paths: string[] = []
  const seam = createBillingSeam({ store, dispatch: store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: store.nextOrdinal,
    http: async path => { paths.push(path); return Response.json(path === "/api/billing/plans" ? { plans, current_plan_key: "free" } : { credit_balance_cents: 1000, sandbox: {
      plan_key: "free", concurrent_sandboxes: 1, concurrent_in_use: 1, idle_timeout_secs: 1800,
      hours_per_day: 4, seconds_used_today: 5400, day_resets_at: "2026-09-16T00:00:00Z"
    } }) }
  }, false)
  expect(await seam.showBillingPlans()).toMatchObject({ value: expect.stringContaining("Credit: $10.00.") })
  expect(paths).toEqual(["/api/billing", "/api/billing/plans"])
  expect(store.collections.billingAccounts.get("billing")).toMatchObject({ planKey: "free", creditBalanceCents: 1000, sandbox: { secondsUsedToday: 5400 } })
  expect(store.collections.cards.get("billing-plans")?.kind).toBe("billing-plans")
  expect(await seam.startCheckout("pro")).toBeUndefined()
  expect(paths).toHaveLength(2)
  await store.dispose?.()
})
test("credit cents render as dollars", () => {
  expect([1000, 0, 5, 123456, -250].map(creditDollars)).toEqual(["$10.00", "$0.00", "$0.05", "$1234.56", "-$2.50"])
})
test("the credit balance sits beside the current plan, and no plan offers bring-your-own-key", () => {
  const { host, close } = render(fixture(), 1000)
  expect(host.querySelector('[aria-current="true"] [data-testid="billing-credit"]')?.textContent).toBe("$10.00")
  expect(host.textContent).not.toMatch(/bring-your-own-key/i)
  close()
  const unknown = render(fixture(), null)
  expect(unknown.host.querySelector('[data-testid="billing-credit"]')).toBeNull()
  unknown.close()
})
