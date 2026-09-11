/*
 * The billing checkout seam: POST /api/billing/checkout {plan} and
 * POST /api/billing/portal answer Stripe URLs the browser navigates to.
 * User-only commands — the agent never opens a payment flow. Reference:
 * multi src/smithersCloud/billing.ts.
 */
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"

export interface BillingSeam {
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

export const createBillingSeam = (ctx: SeamContext): BillingSeam => ({
  startCheckout: (plan) =>
    openSession(
      ctx,
      "/api/billing/checkout",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan === undefined ? {} : { plan })
      },
      "Checkout",
      (url) => `Checkout is ready: ${url}`
    ),
  openBillingPortal: () =>
    openSession(
      ctx,
      "/api/billing/portal",
      { method: "POST" },
      "The billing portal",
      (url) => `Your billing portal: ${url}`
    )
})
