import type { CloudSession } from "@smthrs/rpc/LocalApp"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { ServerConfig } from "./Config"
import { fetchCloudToken } from "./gateway"
import { discardBody, fetchWithDeadline, readText } from "./Http"
import { validateSession } from "./identity"
import { json, refuse } from "./Responses"

/**
 * Web counterpart of the native CloudAuth session. The app's cookie names
 * the user; the existing identity exchange holds their Cloud credential.
 * GitHub OAuth scopes are not Cloud PAT scopes: probe the same read as the
 * native host before publishing the scope verdict. No token leaves here.
 */
export const probeCloudSession = (request: Request) => Effect.gen(function* () {
  const identity = yield* validateSession(request)
  const answer = (session: CloudSession): Response => {
    const response = json(200, session)
    response.headers.set("cache-control", "no-store")
    return response
  }
  if (identity.status === "invalid") return answer({ state: "signed-out", username: null, expiresAt: null })
  if (identity.status === "unavailable") return identity.response
  const token = yield* fetchCloudToken(identity.identity.login)
  if (token.status === "not_eligible") return refuse("account_not_allowlisted", "This account isn't off the closed-alpha waitlist yet.")
  if (token.status !== "ok") return refuse("cloud_token_unavailable", "Smithers Cloud isn't reachable for your account right now.")
  const config = yield* ServerConfig
  const probe = yield* Effect.result(fetchWithDeadline(
    "The Cloud session scope check",
    new URL("/api/user/workspaces", config.cloudApiBaseUrl).toString(),
    { headers: { authorization: `Bearer ${token.token}` } },
    config.upstreamTimeoutMs
  ))
  if (Result.isFailure(probe)) return refuse("upstream_unreachable", "Smithers Cloud could not check your session right now.")
  const response = probe.success
  let degraded = false
  if (response.status === 403) {
    const body = yield* readText(response).pipe(Effect.catch(() => Effect.succeed("")))
    degraded = /insufficient/i.test(body) && /scope/i.test(body)
  } else {
    yield* discardBody(response)
  }
  if (!response.ok && !degraded) return refuse("upstream_refused", "Smithers Cloud could not verify your session right now.")
  return answer({ state: "signed-in", username: identity.identity.login, expiresAt: null, ...(degraded ? { scopes: "degraded" } : {}) })
})
