import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { browserFetchResponseBody } from "@smthrs/rpc/BrowserFetch"
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import { CLIENT_ERROR_UNKNOWN_SOURCE, ClientErrors } from "./clientErrorLog"
import { ServerConfig } from "./Config"
import { BrowserEgress } from "./Environment"
import { fetchCloudToken } from "./gateway"
import { fetchWithDeadline, readBoundedBytes, readText } from "./Http"
import type { Transport } from "./Http"
import { requireTurnSession } from "./identity"
import { isPublicRepositoryRead, readPublicRepository } from "./publicRepositoryReads"
import { json, notFound, readBody, upstreamProse, upstreamUnreachable, withIsolationHeaders } from "./Responses"
import { anonymousBucketAddress } from "./turnLimit"

/*
 * The curated platform proxy (MULTI-ACTIONS-GAP.md Tier 1/2): the browser
 * calls these paths same-origin; the Worker validates the session, mints the
 * user's own Smithers Cloud token (the same per-user door the gateway seam
 * uses), and forwards with that bearer. An ALLOWLIST, never a wildcard —
 * every proxied family is one the product ships commands for. Note
 * /api/billing/checkout|portal are EXACT matches routed to the platform's
 * Stripe seam; the rest of /api/billing/* stays with the product billing
 * worker.
 *
 * Exported for the host parity matrix (apps/app/docs/web-mode/PLAN.md §6):
 * every cloud-present flow whose seam calls `/api/*` or `/api/cloud/*` must
 * name a row here, and the test reads the table the router uses.
 */
export const PLATFORM_PROXY_RULES: ReadonlyArray<{
  readonly prefix?: string
  readonly exact?: string
  readonly methods: ReadonlyArray<string>
}> = [
  { prefix: "/api/repos/", methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  { prefix: "/api/github/import", methods: ["GET", "POST"] },
  /* The signed-in user's mirrored repositories: the web funnel's first list (W0). */
  { prefix: "/api/user/repos", methods: ["GET"] },
  /* Source-only repo metadata (import-readiness fallback): reads only. */
  { prefix: "/api/user/github-repos/", methods: ["GET"] },
  /*
   * Per-user cloud reads the app renders as trees and rows (RepositoriesSeam,
   * WorkspaceSeam). Every row below names only the methods a seam under
   * apps/app/src/mainview/state/seams calls today: the bridge hands the page
   * whatever the platform answers, so a method here is a capability, and a
   * lane that needs a new one adds it in the same commit as its seam
   * (parity-hosts.test.ts (b) reads this table).
   */
  { prefix: "/api/user/workspaces", methods: ["GET"] },
  { prefix: "/api/user/orgs", methods: ["GET"] },
  /* ChangeSeam: the changeset DTO, and landing one (ADR 0003). */
  { prefix: "/api/orgs/", methods: ["GET", "POST"] },
  /* LinearSeam (plue epic #474): integrations list and disconnect; setup lookup, create, sync, ops, per-op retry. */
  { prefix: "/api/integrations/", methods: ["GET", "DELETE"] },
  { prefix: "/api/linear", methods: ["GET", "POST"] },
  { prefix: "/api/notifications/", methods: ["GET", "PUT"] },
  { exact: "/api/billing/checkout", methods: ["POST"] },
  { exact: "/api/billing/portal", methods: ["POST"] }
]

/*
 * The closed alpha exposes no top-up, checkout, or card-collection flow: every
 * account's balance is comped. Both Stripe routes stayed live anyway, so
 * `/billing.upgrade` on an MVP account fired a real POST and came back the
 * platform's `stripe billing is not configured` (repro
 * apps/app/canary-repros/money/17.4). A configuration string is not an answer to
 * "upgrade my plan", and a live checkout call is not something an MVP account
 * should be able to make at all.
 *
 * Set BILLING_CHECKOUT_ENABLED=1 on the deployment where paid plans ship; the
 * routes then forward exactly as before.
 */
const CHECKOUT_PATHS: ReadonlyArray<string> = ["/api/billing/checkout", "/api/billing/portal"]

const PLATFORM_PROXY_MAX_BODY = 256 * 1024
// Plue accepts a 1 MiB binary Yjs update in a base64 JSON envelope (2 MiB cap).
// Keep the larger allowance on this exact mutation, including /api/cloud's
// normalized inner route. Other repository writes retain their existing cap.
const platformBodyLimit = (pathname: string, method: string): number =>
  method === "POST" && /^\/api\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/wiki\/[a-z0-9-]+\/updates$/.test(pathname)
    ? 2 * 1024 * 1024
    : PLATFORM_PROXY_MAX_BODY

/**
 * What to tell a reader when Smithers Cloud refuses. The upstream's own body is
 * used only when it carries prose; a router's plain-text 404 or an HTML error
 * page is replaced by a sentence, never forwarded.
 */
const platformFailureMessage = (status: number, body: string): string => {
  const prose = upstreamProse(body)
  if (prose !== undefined) return prose
  if (status === 404) return "Smithers Cloud doesn't serve that request on this deployment."
  if (status === 401 || status === 403) return "Smithers Cloud refused that request for your account."
  if (status === 429) return "Smithers Cloud is rate-limiting this account right now. Try again in a minute."
  if (status >= 500) return `Smithers Cloud is having trouble right now (HTTP ${status}).`
  return `Smithers Cloud refused that request (HTTP ${status}).`
}

export const platformProxyMatch = (pathname: string, method: string): boolean =>
  PLATFORM_PROXY_RULES.some(
    (rule) =>
      rule.methods.includes(method) &&
      (rule.exact !== undefined
        ? pathname === rule.exact
        : rule.prefix !== undefined && pathname.startsWith(rule.prefix))
  )

/** An anonymous catalog read, restated in the seam's envelope when the mirror refuses. */
const publicAnswer = (url: URL): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const response = yield* readPublicRepository(url, config.cloudApiBaseUrl)
    if (response.ok) return response
    const detail = yield* readText(response).pipe(Effect.catch(() => Effect.succeed("")))
    const failure = json(response.status, {
      status: "error",
      message: platformFailureMessage(response.status, detail)
    })
    failure.headers.set("cache-control", "private, no-store")
    const vary = response.headers.get("vary")
    if (vary !== null) failure.headers.set("vary", vary)
    return failure
  })

export const handlePlatformProxy = (
  request: Request,
  url: URL
): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const publicRead = isPublicRepositoryRead(request.method, url.pathname)
    if (publicRead && !request.headers.has("cookie")) return withIsolationHeaders(yield* publicAnswer(url))
    const gate = yield* requireTurnSession(request)
    if (publicRead && (gate === undefined || (gate instanceof Response && (gate.status === 401 || gate.status === 403)))) {
      return withIsolationHeaders(yield* publicAnswer(url))
    }
    if (gate instanceof Response) return gate
    if (gate === undefined) {
      // No identity seam on this deployment (local dev/stub): the honest state,
      // not a 404 — the client renders the message as-is.
      return json(503, {
        status: "error",
        message: "Repository actions need the identity seam, which this deployment does not have."
      })
    }
    if (CHECKOUT_PATHS.includes(url.pathname) && !config.billingCheckoutEnabled) {
      return json(501, {
        status: "error",
        message:
          "There is nothing to buy during the closed alpha: your balance is comped, so there is no checkout and no billing portal. You'll be told before that changes."
      })
    }
    const token = yield* fetchCloudToken(gate.login)
    if (token.status !== "ok") {
      return json(503, {
        status: "error",
        message: `Smithers Cloud isn't reachable for your account right now (${token.status}).`
      })
    }
    let body: Uint8Array<ArrayBuffer> | undefined
    if (request.method !== "GET" && request.method !== "HEAD") {
      const read = yield* Effect.result(readBoundedBytes(request, platformBodyLimit(url.pathname, request.method)))
      if (Result.isFailure(read)) {
        return read.failure._tag === "BodyTooLarge"
          ? json(413, { status: "error", message: "Request body too large." })
          : json(400, { status: "error", message: "Invalid request." })
      }
      body = read.success
    }
    // The path is joined onto the platform's origin and must still be there
    // once parsed: a bearer never leaves for any other host.
    const target = new URL(url.pathname + url.search, config.cloudApiBaseUrl)
    if (target.origin !== new URL(config.cloudApiBaseUrl).origin) return notFound()
    const headers = new Headers({ authorization: `Bearer ${token.token}` })
    const contentType = request.headers.get("content-type")
    if (contentType !== null) headers.set("content-type", contentType)
    const accept = request.headers.get("accept")
    if (accept !== null) headers.set("accept", accept)
    const fetched = yield* Effect.result(
      fetchWithDeadline(
        "Smithers Cloud",
        target.toString(),
        { method: request.method, headers, ...(body === undefined ? {} : { body }) },
        config.upstreamTimeoutMs
      )
    )
    if (Result.isFailure(fetched)) return upstreamUnreachable("Smithers Cloud", fetched.failure)
    const upstream = fetched.success
    /*
     * A failure never passes through: the upstream's body is written for its
     * own callers, and the product renders whatever comes back straight to the
     * user. Restate it in the seam's own envelope so a reader always gets a
     * sentence, and the shape matches every other refusal this Worker makes.
     */
    if (upstream.status >= 400) {
      const detail = yield* readText(upstream).pipe(Effect.catch(() => Effect.succeed("")))
      return json(upstream.status, { status: "error", message: platformFailureMessage(upstream.status, detail) })
    }
    // Status and body pass through; upstream headers do not (no set-cookie, no
    // upstream CORS) — only the content type survives.
    const out = new Headers()
    out.set("cache-control", "private, no-store")
    const upstreamType = upstream.headers.get("content-type")
    if (upstreamType !== null) out.set("content-type", upstreamType)
    return new Response(upstream.body, { status: upstream.status, headers: out })
  })

/*
 * The `/api/cloud/<inner>` bridge (apps/app/docs/web-mode/PLAN.md §0
 * correction 4). The product's cloud seams call CLOUD_ROUTE_PREFIX + path;
 * the Bun origin forwards that with its Smithers Cloud PAT, and this Worker answered
 * the canonical 404, so on the web the repository list never loaded. The
 * inner path goes through the SAME allowlist and the SAME cookie-to-cloud-
 * token bridge as the direct platform proxy above — one function, so the
 * token, header and failure-message rules cannot fork.
 *
 * The inner path is joined as a plain path, never as a URL (the guard the
 * Bun proxyCloud keeps): `/api/cloud//evil.example/x` sliced naively is
 * scheme-relative and the WHATWG parser would send the bearer to
 * evil.example. `new URL(request.url)` has already folded `..` and `%2e%2e`
 * segments, so a rest the parser would rewrite, or that still carries a dot
 * segment, is refused rather than forwarded. Every refusal is the canonical
 * 404: the bridge enumerates nothing the direct route does not.
 */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i

const cloudInnerUrl = (url: URL): URL | undefined => {
  const rest = url.pathname.slice(CLOUD_ROUTE_PREFIX.length)
  if (rest === "" || rest.startsWith("/") || rest.includes("\\")) return undefined
  const pathname = `/${rest}`
  if (pathname.split("/").some((segment) => DOT_SEGMENT.test(segment))) return undefined
  const inner = new URL(pathname + url.search, url.origin)
  if (inner.origin !== url.origin || inner.pathname !== pathname) return undefined
  return inner
}

export const handleCloudProxy = (request: Request, url: URL): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.suspend(() => {
    const inner = cloudInnerUrl(url)
    if (inner === undefined || !platformProxyMatch(inner.pathname, request.method)) return Effect.succeed(notFound())
    return handlePlatformProxy(request, inner)
  })

/*
 * The browser tool's fetch route (Wave 10, §2d): session-gated exactly like
 * a turn — the deployment's network egress is a resource — and read-tier: it
 * changes nothing upstream. The guards live in the egress service.
 */
export const handleBrowserFetch = (request: Request): Effect.Effect<Response, never, BrowserEgress> =>
  Effect.gen(function* () {
    const body = yield* readBody(request)
    if (body instanceof Response) return body
    const url = typeof body === "object" && body !== null && "url" in body && typeof body.url === "string"
      ? body.url
      : undefined
    if (url === undefined || url.trim() === "") {
      return json(400, { status: "error", message: "Body must be { url }." })
    }
    const egress = yield* BrowserEgress
    if (Option.isNone(egress)) {
      return json(501, { status: "error", message: "Web page reading is unavailable on this host. Open it in the native app." })
    }
    const outcome = yield* egress.value.read(url.trim()).pipe(
      Effect.catch((failure) => Effect.succeed({ ok: false as const, message: `Reading the page failed: ${failure.message}` }))
    )
    return json(outcome.ok ? 200 : 422, browserFetchResponseBody(outcome))
  })

/*
 * Frontend error ingest (multi's /api/client-errors, minimal form): bounded
 * body, logged to the worker tail, kept in the client-error log. The
 * throttle is the log's own (clientErrorLog.ts): a counter here would be per
 * isolate, and workerd runs as many isolates as a flood asks for.
 */
export const CLIENT_ERRORS_PATH = "/api/client-errors"
const CLIENT_ERROR_MAX_BODY = 16 * 1024

/**
 * The source a report is counted against: the client address Cloudflare
 * reports, one IPv6 /64 per bucket as for anonymous turns. Never stored.
 */
const clientErrorSource = (request: Request): string => {
  const ip = request.headers.get("cf-connecting-ip")?.trim() ?? ""
  return ip === "" ? CLIENT_ERROR_UNKNOWN_SOURCE : anonymousBucketAddress(ip)
}

/** The session cookie the identity worker sets. Its value is never read here, only its presence. */
const SESSION_COOKIE = "smithers_session"

/** The request carried a session cookie. Presence only: the log's eviction order needs no more. */
const carriesSessionCookie = (request: Request): boolean =>
  (request.headers.get("cookie") ?? "").split(";").some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`))

export const handleClientError = (request: Request): Effect.Effect<Response, never, ClientErrors> =>
  Effect.gen(function* () {
    const read = yield* Effect.result(readBoundedBytes(request, CLIENT_ERROR_MAX_BODY))
    if (Result.isFailure(read)) {
      return read.failure._tag === "BodyTooLarge"
        ? json(413, { status: "error", message: "Error report too large." })
        : json(400, { status: "error", message: "Invalid request." })
    }
    const text = new TextDecoder().decode(read.success)
    // The log is what makes an alpha user's crash readable afterwards, through
    // GET /api/admin/errors; it is bounded, it decides the throttle, and it
    // never fails the report. console.error alone lives exactly as long as
    // someone is tailing, so a throttled report is not worth a tail line.
    const referer = request.headers.get("referer")
    const userAgent = request.headers.get("user-agent")
    const errors = yield* ClientErrors
    const outcome = yield* errors.append(
      {
        at: new Date().toISOString(),
        ...(referer === null ? {} : { page: referer }),
        ...(userAgent === null ? {} : { userAgent }),
        ...(carriesSessionCookie(request) ? { signedIn: true } : {}),
        report: ((): unknown => {
          try {
            return JSON.parse(text)
          } catch {
            return text
          }
        })()
      },
      clientErrorSource(request)
    )
    if (outcome === "throttled") {
      return json(429, { status: "error", message: "Too many error reports." })
    }
    yield* Effect.sync(() => console.error("client-error:", text))
    return json(202, { status: "accepted" })
  })
