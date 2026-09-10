import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import {
  ADMIN_ROUTE_PREFIX,
  AUTH_CALLBACK_PATH,
  AUTH_ROUTE_PREFIX,
  AUTH_SESSION_PATH,
  AUTH_SIGN_IN_PATH,
  BILLING_ROUTE_PREFIX,
  CANCEL_PATH,
  IDENTITY_ROUTE_PREFIX,
  MODEL_STREAM_PATH,
  RECOMMEND_OUTCOME_PATH,
  RECOMMEND_PATH,
  TOOLS_BROWSER_FETCH_PATH,
  TURN_PATH,
  WORKFLOW_PROVISION_PATH,
  WORKFLOW_RPC_PATH,
  WORKFLOW_TRIGGERS_PATH
} from "@smthrs/rpc/AgentApiRoutes"
import { APP_API_VERSION, APP_BOOTSTRAP_PATH } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import { handleAdmin } from "./admin"
import { catalogDocumentPath, comingSoonDocumentPath, DEFAULT_APP_DOCUMENT_PATH, isFramePath } from "./appDocument"
import { proxyToBilling } from "./billing"
import { runRequest } from "./Boundary"
import { ClientErrorLog } from "./clientErrorLog"
import { DEFAULT_APP_ORIGIN, ServerConfig } from "./Config"
import { Assets, BrowserEgress, DeploymentBindings, ExecutionContext, executionContextFrom, runtimeFor } from "./Environment"
import type { NativeExecutionContext, RequestServices, WorkerEnv } from "./Environment"
import { GatewaySessionRegistry } from "./gateway"
import { handleAuthNavigation, probeAuthSession, proxyToIdentity, requireTurnSession, validateSession } from "./identity"
import {
  CLIENT_ERRORS_PATH,
  handleBrowserFetch,
  handleClientError,
  handleCloudProxy,
  handlePlatformProxy,
  PLATFORM_PROXY_RULES,
  platformProxyMatch
} from "./proxies"
import { AVAILABLE_REPOS, PUBLIC_REPOS_PATH } from "./publicRepoCatalog"
import { handlePublicRepoActivity, parsePublicRepoActivityPath } from "./publicRepoActivity"
import { handlePublicRepos } from "./publicRepos"
import { handleRecommend, handleRecommendOutcome, RecommendLog } from "./recommend"
import { ISOLATION_HEADERS, json, methodNotAllowed, notFound, withIsolationHeaders } from "./Responses"
import {
  ANONYMOUS_ALL_CEILING,
  ANONYMOUS_ALL_KEY,
  ANONYMOUS_CEILING,
  anonymousTurnKey,
  TurnLimits,
  turnLimitResponse,
  TurnRateLimiter
} from "./turnLimit"
import { handleCancel, handleModelStream, handleTurn, readStartTurn, TurnCancelRegistry } from "./turns"
import { handleWorkflowProvision, handleWorkflowRpc, handleWorkflowTriggers } from "./workflows"

/*
 * The deployable Smithers MVP server: a Cloudflare Worker that serves the built
 * site (assets binding, run_worker_first for the API routes) and implements the
 * same-origin `/api/agent` boundary the pure-web client talks to, plus the
 * trusted-proxy seams to the identity, billing, chat and Cloud services.
 * Upstream credentials and origins stay server-side; the browser only ever
 * sees its own origin.
 *
 * This module is the router and the native adapter, nothing else: every route
 * body lives in the module that owns its seam (src/turns.ts, src/identity.ts,
 * src/billing.ts, src/admin.ts, src/proxies.ts, src/workflows.ts, the public
 * catalog modules), and `handleRequest` decides which one answers. The
 * deployed composition is src/Worker.ts; the `default` export at the bottom is
 * the same router under workerd's plain `fetch(request, env, ctx)` shape, for
 * the tests and a local host.
 */

/* The five Durable Object classes wrangler binds, under their frozen names. */
export { ClientErrorLog, GatewaySessionRegistry, RecommendLog, TurnCancelRegistry, TurnRateLimiter }
/* The route tables the host parity matrix and the identity test read. */
export { PLATFORM_PROXY_RULES }
export type { WorkerEnv }
export type { TurnCancelNamespace, TurnCancelStorage } from "./turns"

/*
 * Retired raw gateway mounts. The old static proxy used deployment credentials
 * without a per-request user/target authority. Product clients use the
 * session-validated, per-user /api/workflow/* relay instead. Leftover secrets
 * must never reactivate this path.
 */
const RETIRED_GATEWAY_ROUTE_PREFIXES = ["/rpc", "/projections", "/sync", "/health"] as const

const retiredGatewayProxy = (): Response =>
  json(410, {
    status: "error",
    code: "gateway_proxy_removed",
    message:
      "The static gateway proxy was removed. Use the session-validated /api/workflow/provision and /api/workflow/rpc routes, or connect directly to a separately authenticated gateway."
  })

const isRetiredGatewayRoute = (pathname: string): boolean =>
  RETIRED_GATEWAY_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

const isApiRoute = (pathname: string): boolean => pathname.startsWith("/api/") || isRetiredGatewayRoute(pathname)

/**
 * Same-origin guard for the API surface. These routes spend the deployment's
 * own credentials — `/api/workflow/rpc` relays a gateway procedure under the
 * credential the Worker holds and the browser never sees — and a `text/plain`
 * or form POST from another site is not preflighted, so nothing else would
 * stop a page anywhere from driving them. Requests without an `Origin`
 * (same-origin GETs, top-level OAuth navigation, curl, the e2e) are untouched.
 */
const isCrossOriginRequest = (request: Request, url: URL): boolean => {
  const origin = request.headers.get("origin")
  return origin !== null && origin !== url.origin
}

/*
 * The app under the apex. The product for a repository lives at
 * https://smithers.sh/<owner>/<name>, a page the smithers.sh Astro build
 * (apps/site) prerenders per catalog repository and this Worker serves from
 * that build's dist. The deployment routes only the owner prefixes below to
 * this Worker on the apex and runs it first for them, so this handler, not the
 * assets layer, decides what a repository path answers: a catalog repository's
 * page is the app document with the isolation headers OPFS needs, and every
 * other path under a routed owner is nobody's page, so it leaves for the site
 * instead of a 404 page. The owner list mirrors the `smithers.sh/<owner>/*`
 * routes and the `run_worker_first` entries in src/workerIdentity.ts: a new
 * owner needs all three in one commit (src/workerIdentity.test.ts holds the
 * last two to this list).
 */
export const ROUTED_OWNER_PREFIXES: ReadonlyArray<string> = ["/smithersai/"]

/** Whether `owner/name` is in the public catalog; GitHub names are case-insensitive. */
const isCatalogRepository = (name: unknown): boolean =>
  typeof name === "string" && AVAILABLE_REPOS.some((repo) => repo.name.toLowerCase() === name.toLowerCase())

/**
 * What a repository path answers. A coming-soon repository (COMING_SOON_REPOS)
 * has a prerendered site page and no app. The Worker runs first for its owner
 * (COMING_SOON_WORKER_FIRST), so this branch sees the canonical path and the
 * variants the assets have no file for, and `/effect-ts/effect` reaches the
 * same page instead of the 404 page. A catalog repository under a routed owner
 * is the app document; every other path under a routed owner is nobody's page.
 */
const routedRepoPage = (
  pathname: string
): { readonly kind: "app" | "coming-soon"; readonly document: string } | "unknown" | undefined => {
  const comingSoon = comingSoonDocumentPath(pathname)
  if (comingSoon !== undefined) return { kind: "coming-soon", document: comingSoon }
  const lower = pathname.toLowerCase()
  if (!ROUTED_OWNER_PREFIXES.some((prefix) => lower.startsWith(prefix))) return undefined
  const document = catalogDocumentPath(pathname)
  return document === undefined ? "unknown" : { kind: "app", document }
}

/**
 * The canary is a copy of the product, not a second product: an HTML page it
 * serves must never outrank the apex in a search index.
 */
const CANARY_HOSTNAME = "canary.smithers.sh"

const withCanaryRobots = (url: URL, response: Response): Response => {
  if (url.hostname !== CANARY_HOSTNAME) return response
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return response
  const headers = new Headers(response.headers)
  headers.set("X-Robots-Tag", "noindex")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/*
 * The site build as the assets layer serves it. An assets binding that
 * rejects is not a route outcome any contract names: it is the platform
 * failing under us, and the boundary answers it with the generic logged 500
 * (docs/worker-errors.md), never a hang and never an HTML error page.
 */
const serveAsset = (request: Request): Effect.Effect<Response, never, Assets> =>
  Assets.use((assets) => assets.fetch(request)).pipe(Effect.catch((failure) => Effect.die(failure.cause)))

/*
 * The app document, fetched from the site build by its canonical path
 * (src/appDocument.ts) and served with the isolation headers the app's OPFS
 * persistence needs. Only the app document carries them: the docs pages in
 * the same build load Google Fonts and Pagefind, which COEP require-corp
 * would block.
 */
const serveAppDocument = (request: Request, url: URL, document: string): Effect.Effect<Response, never, Assets> =>
  Effect.map(serveAsset(new Request(new URL(document, url).toString(), request)), withIsolationHeaders)

/*
 * Anonymous exploring (PUBLIC-REPOSITORIES.md): a visitor at
 * smithers.sh/smithersai/smithers talks to Smithers about that repository
 * without an account. The turn names its repository in the runtime context
 * the client derives each turn (`context.activeRepository`); only a catalog
 * repository opens the door, and it opens onto the anonymous ceilings, never
 * onto a user's budget or billing account: the turn carries no login, so the
 * chat upstream meters it to the deployment. Two buckets are spent, and
 * either refuses: the caller's address (one IPv6 /64 is one address) and the
 * deployment-wide `anonymous:all`, which is what caps the day's cost when a
 * caller rotates addresses.
 *
 * What the turn can reach is what the client can reach signed out: the
 * model's tool calls run in the browser, against this Worker, where every
 * write route and the workflow seam still answer 401 without a session and
 * only the public repository reads are open. The turn route forwards the
 * client's messages, instructions, and tool spec to the chat upstream as it
 * does for a login; the ceiling is what bounds the spend.
 */
const anonymousCatalogTurn = (request: Request, refusal: Response): Effect.Effect<Response, never, RequestServices> =>
  Effect.gen(function* () {
    const body = yield* readStartTurn(request)
    if (body instanceof Response) return body
    if (!isCatalogRepository(body.context?.activeRepository)) return refusal
    const config = yield* ServerConfig
    const salt = config.anonymousTurnSalt === undefined ? undefined : Redacted.value(config.anonymousTurnSalt)
    const anonymousKey = yield* anonymousTurnKey(request, salt)
    const limits = yield* TurnLimits
    const budget = yield* limits.spend(anonymousKey, ANONYMOUS_CEILING)
    if (!budget.allowed) return turnLimitResponse(budget, ISOLATION_HEADERS, ANONYMOUS_CEILING)
    // Spent after the address bucket admits, so a visitor who is already at
    // their own ceiling never draws down everyone's.
    const shared = yield* limits.spend(ANONYMOUS_ALL_KEY, ANONYMOUS_ALL_CEILING)
    if (!shared.allowed) return turnLimitResponse(shared, ISOLATION_HEADERS, ANONYMOUS_ALL_CEILING)
    return yield* handleTurn(request, undefined, body)
  })

/** The login's turn ceiling, spent before a model credential is. */
const loginBudget = (login: string): Effect.Effect<Response | undefined, never, TurnLimits> =>
  TurnLimits.use((limits) =>
    Effect.map(limits.spend(login), (budget) => (budget.allowed ? undefined : turnLimitResponse(budget, ISOLATION_HEADERS)))
  )

/*
 * What the app reads first: which doors this deployment has. `terminal` is the
 * W4 relay and stays false until that lane lands, so the Worker never claims a
 * door it has not opened.
 */
const handleBootstrap: Effect.Effect<Response, never, ServerConfig | BrowserEgress | DeploymentBindings> =
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const bindings = yield* DeploymentBindings
    const egress = yield* BrowserEgress
    const identity = config.identityUpstreamUrl !== undefined
    return json(200, {
      apiVersion: APP_API_VERSION,
      host: "cloud",
      version: "1.0.0",
      buildSha: config.buildSha,
      capabilities: cloudCapabilities({
        identity,
        cloud: bindings.cloudApi,
        agent: config.chatAuthToken !== undefined || config.chatProductServiceToken !== undefined,
        checkout: config.billingCheckoutEnabled,
        terminal: false,
        browser: Option.isSome(egress)
      }),
      authFlow: identity ? "redirect" : "none",
      sandbox: null
    })
  })

/**
 * The router: one request in, one response out, never a failure. Every
 * refusal a contract names is a Response; an interruption (the client went
 * away) stays an interruption for the boundary to answer 499; anything else
 * is a defect the boundary logs and answers with the generic 500.
 */
export const handleRequest = (request: Request): Effect.Effect<Response, never, RequestServices> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    // This one curated, read-only catalog is public to the marketing site.
    // Every authenticated API continues through the same-origin guard below.
    if (url.pathname === PUBLIC_REPOS_PATH) return yield* handlePublicRepos(request)
    // The catalog's recent-activity sentence (src/publicRepoActivity.ts): a
    // public read computed from the Cloud mirror, never from GitHub.
    if (parsePublicRepoActivityPath(url.pathname) !== undefined) return yield* handlePublicRepoActivity(request)
    // Retired mounts never forward, even on WebSocket upgrade or when legacy
    // deployment credentials are still configured.
    const retiredGatewayRoute = isRetiredGatewayRoute(url.pathname)
    if (isApiRoute(url.pathname) && isCrossOriginRequest(request, url)) {
      return json(403, { status: "error", message: "This API only answers requests from its own origin." })
    }
    // The command recommender (src/recommend.ts): open to a visitor as well
    // as a login, under its own ceilings. A login is the bucket when the
    // session validates; anything else, including identity being down, is
    // the visitor's address bucket, because the pills must never wait on
    // sign-in and never spend a real model turn.
    if (url.pathname === RECOMMEND_PATH || url.pathname === RECOMMEND_OUTCOME_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      if (url.pathname === RECOMMEND_OUTCOME_PATH) return yield* handleRecommendOutcome(request, ISOLATION_HEADERS)
      const validation = request.headers.has("cookie") ? yield* validateSession(request) : undefined
      const login = validation?.status === "valid" ? validation.identity.login : undefined
      return yield* handleRecommend(request, login, ISOLATION_HEADERS)
    }
    if (url.pathname === APP_BOOTSTRAP_PATH) {
      if (request.method !== "GET") return methodNotAllowed()
      return yield* handleBootstrap
    }
    if (url.pathname === CANCEL_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      const refusal = yield* requireTurnSession(request)
      // A signed-out caller may kill its own anonymous turn: the registry
      // refuses an owned registration to anyone but its owner, and cancelling
      // spends nothing.
      if (refusal instanceof Response && refusal.status !== 401) return refusal
      return yield* handleCancel(request, refusal instanceof Response ? undefined : refusal)
    }
    // The two routes that spend a model credential. Both gate on the
    // session first and then on the login's turn ceiling, so a refusal
    // costs one Durable Object read and never reaches an upstream. The
    // cancel route above is deliberately unlimited: killing a turn must
    // always work, and it spends nothing.
    if (url.pathname === TURN_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      const gate = yield* requireTurnSession(request)
      if (gate instanceof Response) return gate.status === 401 ? yield* anonymousCatalogTurn(request, gate) : gate
      if (gate !== undefined) {
        const refused = yield* loginBudget(gate.login)
        if (refused !== undefined) return refused
      }
      return yield* handleTurn(request, gate)
    }
    if (url.pathname === MODEL_STREAM_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      const gate = yield* requireTurnSession(request)
      if (gate instanceof Response) return gate
      if (gate !== undefined) {
        const refused = yield* loginBudget(gate.login)
        if (refused !== undefined) return refused
      }
      return yield* handleModelStream(request, gate)
    }
    if (url.pathname === WORKFLOW_PROVISION_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      return yield* handleWorkflowProvision(request)
    }
    if (url.pathname === WORKFLOW_RPC_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      return yield* handleWorkflowRpc(request)
    }
    if (url.pathname === WORKFLOW_TRIGGERS_PATH) {
      if (request.method !== "GET") return methodNotAllowed()
      return yield* handleWorkflowTriggers(request, url)
    }
    if (url.pathname === TOOLS_BROWSER_FETCH_PATH) {
      if (request.method !== "POST") return methodNotAllowed()
      // Session-gated exactly like a turn: the deployment's network egress
      // is a resource.
      const refusal = yield* requireTurnSession(request)
      if (refusal instanceof Response) return refusal
      return yield* handleBrowserFetch(request)
    }
    if ((url.pathname === AUTH_SIGN_IN_PATH || url.pathname === AUTH_CALLBACK_PATH) && request.method === "GET") {
      return yield* handleAuthNavigation(request, url.pathname === AUTH_SIGN_IN_PATH ? "start" : "callback")
    }
    if (url.pathname === AUTH_SESSION_PATH && request.method === "GET") return yield* probeAuthSession(request)
    if (url.pathname.startsWith(AUTH_ROUTE_PREFIX) || url.pathname.startsWith(IDENTITY_ROUTE_PREFIX)) {
      return yield* proxyToIdentity(request)
    }
    if (url.pathname === CLIENT_ERRORS_PATH && request.method === "POST") return yield* handleClientError(request)
    if (url.pathname.startsWith(CLOUD_ROUTE_PREFIX)) return yield* handleCloudProxy(request, url)
    if (platformProxyMatch(url.pathname, request.method)) return yield* handlePlatformProxy(request, url)
    if (url.pathname.startsWith(BILLING_ROUTE_PREFIX)) return yield* proxyToBilling(request)
    if (url.pathname.startsWith(ADMIN_ROUTE_PREFIX)) return yield* handleAdmin(request, url)
    if (retiredGatewayRoute) return retiredGatewayProxy()
    // Any other /api/* path is an unknown route: the same canonical 404 the
    // admin surface answers non-admins with, so nothing is enumerable.
    if (url.pathname.startsWith("/api/")) return notFound()
    const repoPage = routedRepoPage(url.pathname)
    if (repoPage === "unknown") {
      return new Response(null, { status: 302, headers: { location: `${DEFAULT_APP_ORIGIN}/` } })
    }
    if (repoPage !== undefined && repoPage.kind === "coming-soon") {
      // A page of the site, served as the assets layer serves every other
      // page: it loads Google Fonts, which the app's COEP would block.
      return withCanaryRobots(url, yield* serveAsset(new Request(new URL(repoPage.document, url).toString(), request)))
    }
    if (repoPage !== undefined) return withCanaryRobots(url, yield* serveAppDocument(request, url, repoPage.document))
    // A reload or a deep link inside the app: the frame path names no file in
    // the build, so the Worker serves the app document for it.
    if (isFramePath(url.pathname)) {
      return withCanaryRobots(url, yield* serveAppDocument(request, url, DEFAULT_APP_DOCUMENT_PATH))
    }
    // Everything else is the site build as the assets layer serves it: the
    // landing page, the docs, the hashed chunks, and its 404 page.
    return withCanaryRobots(url, yield* serveAsset(request))
  })

/**
 * The native adapter: workerd's `fetch(request, env, ctx)` shape over the
 * router, for the tests and a local host (src/Worker.ts is the deployed
 * composition). This is the one place a request's Effect meets a Promise:
 * `runRequest` (src/Boundary.ts) wires the client's disconnect to fiber
 * interruption, and `runtimeFor` keeps the isolate's services alive across
 * requests, so a cache or a single-flight gate built once is reused. The
 * execution context is per request: with one, work a route hands to
 * `waitUntil` (a turn's settlement) outlives the response.
 */
export default {
  fetch: (request: Request, env: WorkerEnv, ctx?: NativeExecutionContext): Promise<Response> =>
    runRequest(
      handleRequest(request).pipe(Effect.provideService(ExecutionContext, executionContextFrom(ctx))),
      request.signal,
      runtimeFor(env)
    )
}
