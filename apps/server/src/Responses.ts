import * as Effect from "effect/Effect"
import type { BodyFailure, UpstreamFailure } from "./Failures"
import { readBoundedJson } from "./Http"

/*
 * The answers every route of this Worker composes: the JSON envelope with the
 * isolation headers the app's OPFS persistence needs, the canonical refusals,
 * and the sentences an upstream failure earns. Status codes and message text
 * are the HTTP contract the product renders verbatim, so they live here, once.
 */

/** The OPFS SQLite persistence in the SPA needs cross-origin isolation. */
export const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
} as const

export const withIsolationHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...ISOLATION_HEADERS }
  })

/*
 * The canonical unknown-route answer. The admin surface is non-enumerable
 * (Launch Checklist §E): a non-admin — or signed-out — caller probing
 * /api/admin/* gets EXACTLY this response, byte-identical to any other
 * unknown /api/* route. Never 401, never 403, never a different shape.
 */
export const notFound = (): Response => json(404, { status: "error", message: "Not found." })

export const methodNotAllowed = (): Response => json(405, { status: "error", message: "Method not allowed." })

export const notConfigured = (name: string, detail: string): Response =>
  json(501, { status: "error", message: `${name} is not configured on this deployment (${detail}).` })

/**
 * Cap for a single turn request body. Every turn replays the whole transcript,
 * so this is a conversation-length ceiling, not a per-message one. At 64 KB
 * seven long answers wedged the seam permanently on canary and `/clear` could
 * not recover it, because `/clear` runs a model turn of its own and hit the
 * same refusal (repro apps/app/canary-repros/chat/4.13). The Vite dev boundary
 * (`src/server/AgentApi.ts`) allows 1 MB, so the two boundaries now agree and a
 * conversation that passes in dev passes here.
 */
export const MAX_BODY_BYTES = 1024 * 1024

/*
 * Every model call replays the whole transcript, so "too large" is a fact about
 * the CONVERSATION, not about the message that tripped it. The turn seam said
 * so; the model relay — which since the browser chain became the only backend
 * carries every turn — still answered the bare `Request body is too large.`,
 * which names nothing the reader can act on (repro
 * apps/app/canary-repros/chat/4.13). One sentence, both doors.
 */
export const TRANSCRIPT_TOO_LARGE =
  "This conversation has grown too long to send in one turn. Start a new conversation to keep going — nothing was charged, and the transcript above stays where it is."

export const BODY_TOO_LARGE = "Request body is too large."

/** The refusal a request body earns: the ceiling, non-JSON, or a stream that failed. */
export const bodyRefusal = (failure: BodyFailure, tooLarge: string = BODY_TOO_LARGE): Response => {
  switch (failure._tag) {
    case "BodyTooLarge":
      return json(413, { status: "error", message: tooLarge })
    case "BodyNotJson":
      return json(400, { status: "error", message: "Request body must be valid JSON." })
    case "BodyUnreadable":
      return json(400, {
        status: "error",
        message: failure.cause instanceof Error ? failure.cause.message : "Invalid request."
      })
  }
}

/** A JSON request body under the turn ceiling, or the refusal it earns. */
export const readBody = (request: Request, tooLarge: string = BODY_TOO_LARGE): Effect.Effect<unknown | Response> =>
  readBoundedJson(request, MAX_BODY_BYTES).pipe(Effect.catch((failure) => Effect.succeed(bodyRefusal(failure, tooLarge))))

/**
 * A proxy whose upstream never answered. Returning the raw rejection would end
 * the fetch handler with an uncaught exception, and workerd answers that with
 * its own `Error 1101 Worker threw exception` HTML page — which the transcript
 * then renders verbatim to the user (repro apps/app/canary-repros/honesty/24.3,
 * the §24.4 note). A named JSON refusal is the honest answer instead.
 */
export const upstreamUnreachable = (seam: string, failure: UpstreamFailure): Response =>
  failure._tag === "UpstreamTimeout"
    ? json(504, { status: "error", message: `${failure.message} Try again in a moment.` })
    : json(502, { status: "error", message: `${seam} is unreachable right now: ${causeMessage(failure.cause)}` })

/** The prose of a native cause, or the seam's placeholder. */
export const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : "unknown error")

/**
 * The prose inside an upstream error body, or undefined when the body was
 * written for a machine. This is the rule the seam keeps: a Cloudflare HTML
 * page, a Go router's `404 page not found`, and a provider's error envelope
 * are never handed to a reader. Only a `message`/`error` string — a field an
 * upstream fills with a sentence — survives.
 */
export const upstreamProse = (body: string): string | undefined => {
  const text = body.trim()
  if (text === "" || text.startsWith("<")) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as { message?: unknown; error?: unknown }
  const nested = typeof record.error === "object" && record.error !== null
    ? (record.error as { message?: unknown }).message
    : record.error
  const prose = [record.message, nested].find(
    (value): value is string => typeof value === "string" && value.trim() !== ""
  )
  return prose === undefined ? undefined : prose.trim().slice(0, 200)
}

/**
 * One sentence a reader can act on for an upstream that refused. The status is
 * classified here rather than trusting every upstream to write user-facing
 * prose: a provider's raw rate-limit JSON was pasted straight into the
 * transcript on canary (repro apps/app/canary-repros/honesty/24.3), and a
 * Worker 500 arrived as a Cloudflare HTML page.
 */
export const upstreamFailureMessage = (status: number, body: string, retryAfter: string | null): string => {
  if (status === 429) {
    const seconds = Number(retryAfter ?? "")
    const when = Number.isFinite(seconds) && seconds > 0
      ? `Try again in about ${seconds < 90 ? `${Math.ceil(seconds)} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`
      : "Try again in a minute."
    return `The model service is rate-limiting this deployment right now, so the turn did not run. Nothing was charged. ${when}`
  }
  if (status === 401 || status === 403) {
    return "The model service refused this deployment's credentials, so the turn did not run. Nothing was charged, and this is a deployment configuration problem rather than anything to fix from here."
  }
  if (status === 413) {
    return "This conversation has grown too long for the model service to accept. Start a new conversation to keep going — nothing was charged."
  }
  const prose = upstreamProse(body)
  if (status >= 500) {
    return `The model service is having trouble right now (HTTP ${status}), so the turn did not run. Nothing was charged.${
      prose === undefined ? "" : ` It said: ${prose}`
    }`
  }
  return prose === undefined
    ? `The model service refused this turn (HTTP ${status}).`
    : `The model service refused this turn: ${prose}`
}

/**
 * Identity headers a client must never be trusted for: the proxy strips them off
 * every gateway-bound request and re-injects them only from a validated session
 * (trusted-proxy pattern, docs/guides/custom-workflow-ui.mdx).
 */
export const STRIPPED_IDENTITY_HEADERS = [
  "x-user-id",
  "x-user-scopes",
  "x-user-role",
  "x-user-login",
  "x-smithers-token-id",
  "x-smithers-service-token",
  "x-smithers-admin-token",
  "authorization"
] as const

/**
 * The siblings' own admin surfaces. The product spends the admin token only
 * from its /api/admin/* routes, after the caller's session validates as
 * admin:true (admin.ts). The transparent proxies never reach these paths: a
 * caller who holds an upstream admin credential can use it against the
 * upstream directly, and one who does not gets the canonical 404, so nothing
 * here is enumerable.
 */
export const SIBLING_ADMIN_ROUTE_PREFIXES = ["/api/identity/admin/", "/api/billing/admin/"] as const

export const siblingAdminRoute = (pathname: string): boolean =>
  SIBLING_ADMIN_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))

/**
 * Both sibling workers gate on the browser `Origin` (`ALLOWED_ORIGINS`), and a
 * same-origin GET carries none at all, so the proxy states the one origin that
 * is actually true of every request it forwards: its own. Deployments must list
 * this Worker's origin in the identity and billing workers' `ALLOWED_ORIGINS`.
 */
export const withProxyOrigin = (headers: Headers, url: URL): void => {
  headers.set("origin", url.origin)
}

/** The request's headers with every client-supplied identity claim removed. */
export const strippedHeaders = (request: Request): Headers => {
  const headers = new Headers(request.headers)
  for (const name of STRIPPED_IDENTITY_HEADERS) headers.delete(name)
  return headers
}
