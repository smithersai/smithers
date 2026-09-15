import { BILLING_OVERVIEW_PATH, BILLING_PLANS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { BillingOverviewSchema, BillingPlansResponseSchema } from "@smthrs/rpc/BillingPlans"
import { storedRefusal, type Refusal } from "@smthrs/rpc/Refusal"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
import type { AppStore } from "../AppStore"

/*
 * The billing checkout seam: POST /api/billing/checkout {plan} and
 * POST /api/billing/portal answer Stripe URLs the browser navigates to.
 * User-only commands — the agent never opens a payment flow. Reference:
 * multi src/smithersCloud/billing.ts.
 */
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"

export interface BillingSeam {
  readonly showBillingPlans: () => Promise<string | { readonly value: string }>
  readonly startCheckout: (plan?: string) => Promise<string | void>
  readonly openBillingPortal: () => Promise<string | void>
}

/** The Stripe session URL out of a billing response body (multi billing.ts sessionUrl). */
const sessionUrl = (body: unknown): string | undefined => {
  const url = (body as { url?: unknown } | null | undefined)?.url
  return typeof url === "string" && url !== "" ? url : undefined
}

/** Only an https: URL is worth opening — anything else is refused, not navigated. */
const isHttps = (url: string): boolean => {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}

/*
 * The shared session dance: POST, read {url}, refuse non-https, open a tab
 * when a window exists, and always state the act in the transcript so the
 * link survives a blocked popup.
 */
const openSession = async (
  ctx: SeamContext,
  path: string,
  init: RequestInit,
  what: string,
  announce: (url: string) => string
): Promise<string | void> => {
  let response: Response
  try {
    response = await ctx.http(`${ctx.baseUrl}${path}`, init)
  } catch {
    return `${what} couldn't start — the billing service didn't answer.`
  }
  if (!response.ok) return readErrorMessage(response, `${what} couldn't start right now.`)
  const body = (await response.json().catch(() => undefined)) as unknown
  const url = sessionUrl(body)
  if (url === undefined) return `${what} couldn't start — the billing service didn't return a URL.`
  if (!isHttps(url)) return `${what} was refused — the billing service answered with a non-https URL.`
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener")
  ctx.dispatch({ type: "message.appended", actor: "system", text: announce(url) })
}

/** A refusal can precede workspace creation; its upgrade door still embeds in the transcript. */
export const renderPlanLimit = (store: AppStore, refusal: Refusal, checkout: boolean, actor: "user" | "smithers") => {
  const account = store.collections.billingAccounts.get("billing")
  store.dispatch({ type: "card.upsert", actor, card: {
    id: "billing-plan-limit", kind: "billing-plans", title: "Sandbox limit", status: "active",
    createdAt: Date.now(), ordinal: store.nextOrdinal(), payload: {
      planKey: refusal.plan_key ?? account?.planKey ?? null,
      sandbox: account?.sandbox ?? null, plans: account?.plans ?? [], checkout,
      refusal: storedRefusal(refusal)
    }
  } })
  return refusalSentence(refusal)
}

export const createBillingSeam = (ctx: SeamContext, checkout = true): BillingSeam => ({
  showBillingPlans: async () => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    const current = () => ctx.store.collections.identitySessions.get("identity") === identity
    try {
      const [overviewResponse, plansResponse] = await Promise.all([
        ctx.http(`${ctx.baseUrl}${BILLING_OVERVIEW_PATH}`), ctx.http(`${ctx.baseUrl}${BILLING_PLANS_PATH}`)
      ])
      if (!overviewResponse.ok || !plansResponse.ok) return "Your plans couldn't be refreshed right now."
      const overview = BillingOverviewSchema.safeParse(await overviewResponse.json())
      const catalog = BillingPlansResponseSchema.safeParse(await plansResponse.json())
      if (!current()) return { value: "The account changed while plans were loading." }
      if (!overview.success || !catalog.success) return "Your plans couldn't be refreshed right now."
      const wire = overview.data.sandbox
      const sandbox = {
        concurrentSandboxes: wire.concurrent_sandboxes, concurrentInUse: wire.concurrent_in_use,
        idleTimeoutSecs: wire.idle_timeout_secs, hoursPerDay: wire.hours_per_day,
        secondsUsedToday: wire.seconds_used_today, dayResetsAt: wire.day_resets_at
      }
      const planKey = wire.plan_key
      const plans = catalog.data.plans
      ctx.dispatch({ type: "billing.plans.loaded", actor: ctx.actor(), planKey, sandbox, plans })
      ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: {
        id: "billing-plans", kind: "billing-plans", title: "Plans", status: "active",
        createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload: { planKey, sandbox, plans, checkout }
      } })
      return { value: `Current plan: ${planKey}. Running sandboxes: ${sandbox.concurrentInUse} / ${sandbox.concurrentSandboxes}. Sandbox-hours today: ${sandbox.secondsUsedToday / 3600} / ${sandbox.hoursPerDay === -1 ? "unlimited" : sandbox.hoursPerDay}. Resets at ${sandbox.dayResetsAt}. Plans: ${plans.map(plan => `${plan.display_name} $${plan.price_cents / 100}`).join(", ")}.${checkout ? "" : " Checkout is not open yet."}` }
    } catch {
      return "Your plans couldn't be refreshed — the billing service didn't answer."
    }
  },
  startCheckout: (plan) => {
    if (!checkout) {
      ctx.dispatch({ type: "message.appended", actor: ctx.actor(), text: "Checkout is not open yet." })
      return Promise.resolve()
    }
    return openSession(
      ctx,
      "/api/billing/checkout",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan === undefined ? {} : { plan })
      },
      "Checkout",
      (url) => `Checkout is ready: ${url}`
    )
  },
  openBillingPortal: () => {
    if (!checkout) {
      ctx.dispatch({ type: "message.appended", actor: ctx.actor(), text: "Checkout is not open yet." })
      return Promise.resolve()
    }
    return openSession(
      ctx,
      "/api/billing/portal",
      { method: "POST" },
      "The billing portal",
      (url) => `Your billing portal: ${url}`
    )
  }
})
