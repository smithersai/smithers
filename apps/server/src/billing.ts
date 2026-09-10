import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { ServerConfig } from "./Config"
import type { Transport } from "./Http"
import { forwardUnderDeadline, validateSession } from "./identity"
import { json, notConfigured, notFound, siblingAdminRoute, strippedHeaders, withProxyOrigin } from "./Responses"

/**
 * Billing reads dollars for one authenticated account. Wave 13: a SIGNED-IN
 * user reads their OWN account through the wave-5 trusted-caller path — the
 * proxy strips every client-supplied identity claim (a browser must never pick
 * the account), validates the session against identity, and authenticates to
 * billing with `x-smithers-service-token: <BILLING_PRODUCT_SERVICE_TOKEN>` +
 * `x-user-login: <validated login>` (workers/billing keys the account by that
 * login). The deployment-wide bearer is NEVER sent alongside: billing's
 * bearer-wins rule would silently re-key the read to the shared account, which
 * is exactly the D-1/D-2/A-5 defect this path closes.
 *
 * The deployment bearer remains only as the signed-out/native fallback: with no
 * identity seam (local dev, the native shell) there is no session to vouch for,
 * so the bearer authenticates the deployment account it always did. A signed-in
 * request with no service token configured is an honest 501 — never a silent
 * fall back onto the shared account.
 */
export const proxyToBilling = (request: Request): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.billingUpstreamUrl === undefined) {
      return notConfigured("The billing seam", "BILLING_UPSTREAM_URL is unset. Balance is unavailable")
    }
    const url = new URL(request.url)
    if (siblingAdminRoute(url.pathname)) return notFound()
    const target = new URL(url.pathname + url.search, config.billingUpstreamUrl)
    const headers = strippedHeaders(request)

    const validation = yield* validateSession(request)
    if (validation.status === "unavailable") return validation.response
    if (validation.status === "valid") {
      const session = validation.identity
      if (config.billingProductServiceToken === undefined) {
        return notConfigured(
          "The billing seam",
          "BILLING_PRODUCT_SERVICE_TOKEN is unset. A signed-in user's balance reads through the trusted-caller path; without it the seam could only bill the shared deployment account, so it says so instead"
        )
      }
      headers.set("x-smithers-service-token", Redacted.value(config.billingProductServiceToken))
      headers.set("x-user-login", session.login)
      headers.set("x-user-id", session.login)
      headers.set("x-user-role", session.admin ? "admin" : "member")
      if (session.scopes.length > 0) headers.set("x-user-scopes", session.scopes.join(" "))
    } else {
      if (config.identityUpstreamUrl !== undefined) {
        return json(401, {
          status: "error",
          message: "Sign in before reading your balance — the identity service did not validate a session."
        })
      }
      if (config.billingAuthToken === undefined) {
        return notConfigured(
          "The billing seam",
          "BILLING_AUTH_TOKEN is unset. Billing authenticates the account with a Smithers Cloud user bearer, and no other credential opens it"
        )
      }
      headers.set("authorization", `Bearer ${Redacted.value(config.billingAuthToken)}`)
    }
    withProxyOrigin(headers, url)
    return yield* forwardUnderDeadline(
      "The billing service",
      new Request(target.toString(), new Request(request, { headers })),
      config.upstreamTimeoutMs
    )
  })
