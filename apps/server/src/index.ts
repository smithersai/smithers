import {
  ADMIN_ALLOWLIST_PATH,
  ADMIN_ERRORS_PATH,
  ADMIN_GRANT_PATH,
  ADMIN_HEALTH_PATH,
  ADMIN_RECOMMEND_LOG_PATH,
  ADMIN_REQUESTS_PATH,
  ADMIN_ROUTE_PREFIX,
  AUTH_CALLBACK_PATH,
  AUTH_RETURN_TO_PARAM,
  AUTH_ROUTE_PREFIX,
  AUTH_SESSION_PATH,
  AUTH_SIGN_IN_PATH,
  AUTH_SIGNED_IN_PARAM,
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
import { AgentRuntimeContextSchema, composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import { browserFetch, browserFetchResponseBody, resolveHostOverHttps } from "@smthrs/rpc/BrowserFetch"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { appendClientError, CLIENT_ERROR_UNKNOWN_SOURCE, ClientErrorLog, readClientErrors } from "./clientErrorLog"
import type { ClientErrorNamespace } from "./clientErrorLog"
import { handleCloudRoleTurn, isCloudRoleTurn, turnHints } from "./cloudRoleTurn"
import type { CloudRoleEnv, TurnRequest } from "./cloudRoleTurn"
import { handleRecommend, handleRecommendOutcome, readRecommendLog, RecommendLog } from "./recommend"
import type { RecommendEnv } from "./recommend"
import {
  callGateway,
  DEFAULT_CLOUD_API_BASE_URL,
  ensureGateway,
  isGatewayWorkspaceId,
  fetchCloudToken,
  GatewaySessionRegistry,
  isRelayRepoName
} from "./gateway"
import {
  decodeGatewayResponse,
  encodeGatewayRequest,
  GATEWAY_PROCEDURE_MOUNTS,
  NON_REPLAYABLE_GATEWAY_PROCEDURES
} from "./gatewayRpc"
import type { GatewaySessionNamespace } from "./gateway"
import {
  ANONYMOUS_ALL_CEILING,
  ANONYMOUS_ALL_KEY,
  ANONYMOUS_CEILING,
  anonymousBucketAddress,
  anonymousTurnKey,
  spendTurn,
  turnLimitResponse,
  TurnRateLimiter
} from "./turnLimit"
import type { TurnLimitNamespace } from "./turnLimit"
import { catalogDocumentPath, comingSoonDocumentPath, DEFAULT_APP_DOCUMENT_PATH, isFramePath } from "./appDocument"
import { AVAILABLE_REPOS, PUBLIC_REPOS_PATH } from "./publicRepoCatalog"
import { handlePublicRepos } from "./publicRepos"
import { createPublicRepoActivityHandler, parsePublicRepoActivityPath } from "./publicRepoActivity"
import { isPublicRepositoryRead, readPublicRepository } from "./publicRepositoryReads"
import { upstreamDeadline } from "./upstreamDeadline"
import { LIST_TRIGGERS_PAYLOAD, noLiveTriggers, workflowTriggersFromFrame } from "./workflowTriggers"

const { run: withDeadline, timeoutMs: upstreamTimeoutMs, TimeoutError: UpstreamTimeoutError } = upstreamDeadline

/* The per-user gateway session registry (Wave 11) — wrangler binds this DO. */
export { GatewaySessionRegistry }
/* The per-login turn ceiling and the client-error log — wrangler binds both. */
export { ClientErrorLog, RecommendLog, TurnRateLimiter }

/*
 * The deployable Smithers MVP server: a Cloudflare Worker that serves the built
 * SPA (assets binding, run_worker_first for the API routes) and implements the
 * same-origin `/api/agent` boundary the pure-web client talks to, plus the
 * trusted-proxy seam for the future engine gateway. Upstream credentials and
 * origin stay server-side; the browser only ever sees its own origin.
 */

const DEFAULT_CHAT_URL = "https://chat.smithers.sh/chat"
const DEFAULT_APP_ORIGIN = "https://smithers.sh"

/**
 * Cap for a single turn request body. Every turn replays the whole transcript,
 * so this is a conversation-length ceiling, not a per-message one. At 64 KB
 * seven long answers wedged the seam permanently on canary and `/clear` could
 * not recover it, because `/clear` runs a model turn of its own and hit the
 * same refusal (repro apps/ui/canary-repros/chat/4.13). The Vite dev boundary
 * (`src/server/AgentApi.ts`) allows 1 MB, so the two boundaries now agree and a
 * conversation that passes in dev passes here.
 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * The prose inside an upstream error body, or undefined when the body was
 * written for a machine. This is the rule the seam keeps: a Cloudflare HTML
 * page, a Go router's `404 page not found`, and a provider's error envelope
 * are never handed to a reader. Only a `message`/`error` string — a field an
 * upstream fills with a sentence — survives.
 */
const upstreamProse = (body: string): string | undefined => {
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
 * transcript on canary (repro apps/ui/canary-repros/honesty/24.3), and a
 * Worker 500 arrived as a Cloudflare HTML page.
 */
const upstreamFailureMessage = (status: number, body: string, retryAfter: string | null): string => {
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

/** The OPFS SQLite persistence in the SPA needs cross-origin isolation. */
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
} as const

/**
 * Identity headers a client must never be trusted for: the proxy strips them off
 * every gateway-bound request and re-injects them only from a validated session
 * (trusted-proxy pattern, docs/guides/custom-workflow-ui.mdx).
 */
const STRIPPED_IDENTITY_HEADERS = [
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
 * admin:true (handleAdmin, forwardAdminCall). The transparent proxies never
 * reach these paths: a caller who holds an upstream admin credential can use
 * it against the upstream directly, and one who does not gets the canonical
 * 404, so nothing here is enumerable.
 */
const SIBLING_ADMIN_ROUTE_PREFIXES = ["/api/identity/admin/", "/api/billing/admin/"] as const

const siblingAdminRoute = (pathname: string): boolean =>
  SIBLING_ADMIN_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))

/*
 * Retired raw gateway mounts. The old static proxy used deployment credentials
 * without a per-request user/target authority. Product clients use the
 * session-validated, per-user /api/workflow/* relay instead. Leftover secrets
 * must never reactivate this path.
 */
const RETIRED_GATEWAY_ROUTE_PREFIXES = ["/rpc", "/projections", "/sync", "/health"] as const

/*
 * Server-side turn cancellation, the workerd-legal way. workerd forbids
 * touching another request's I/O (the old route aborted the turn handler's
 * AbortController cross-request and 500'd), so cancellation state lives in a
 * Durable Object keyed by runId — the one shared, transactional store two
 * requests may both reach. The cancel route only flips that state; the turn
 * handler polls it between NDJSON chunks (each poll is the turn request's own
 * I/O) and aborts ITS OWN upstream fetch when it sees "cancelled".
 *
 * The structurally-typed binding keeps this Worker free of a workers-types
 * dependency, matching the ASSETS binding above.
 */
export interface TurnCancelStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (key: string, value: unknown) => Promise<void>
}

export interface TurnCancelStub {
  readonly fetch: (request: Request) => Promise<Response>
}

export interface TurnCancelNamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => TurnCancelStub
}

type TurnCancelStateName = "active" | "cancelled" | "settled"

interface TurnCancelState {
  readonly state: TurnCancelStateName
  readonly generation: string
  readonly at: number
  /**
   * The validated login that registered the run, when the deployment has an
   * identity seam. Only the owner may cancel an owned registration; an
   * ownerless one (local dev, no seam) is cancellable by anyone, as before.
   */
  readonly owner?: string
}

/** Internal header carrying the registering/cancelling login between this Worker and its Durable Object. */
const TURN_OWNER_HEADER = "x-turn-owner"
const TURN_GENERATION_HEADER = "x-turn-generation"

const TURN_STATE_KEY = "state"
/**
 * A turn that never settled (its request died before the stream ended) must
 * not hold its runId hostage forever: an "active" registration older than
 * this is treated as settled. Turns are seconds long; ten minutes is far
 * beyond any honest stream.
 */
const STALE_ACTIVE_MS = 10 * 60 * 1000

export class TurnCancelRegistry {
  constructor(private readonly ctx: { readonly storage: TurnCancelStorage }) {}

  private async read(): Promise<TurnCancelState | undefined> {
    return this.ctx.storage.get<TurnCancelState>(TURN_STATE_KEY)
  }

  private async write(state: TurnCancelStateName, generation: string, owner?: string): Promise<void> {
    await this.ctx.storage.put(TURN_STATE_KEY, { state, generation, at: Date.now(), ...(owner === undefined ? {} : { owner }) })
  }

  async fetch(request: Request): Promise<Response> {
    const answer = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    const current = await this.read()
    const stale = current?.state === "active" && Date.now() - current.at > STALE_ACTIVE_MS
    const matches = current?.generation !== undefined &&
      request.headers.get(TURN_GENERATION_HEADER) === current.generation
    switch (new URL(request.url).pathname) {
      case "/register": {
        if (current?.state === "active" && !stale) return answer({ status: "already-running" })
        const generation = crypto.randomUUID()
        await this.write("active", generation, request.headers.get(TURN_OWNER_HEADER) ?? undefined)
        return answer({ status: "started", generation })
      }
      // Resolve the public runId to a generation before attempting its cancel.
      case "/current": {
        if (current?.state !== "active" || stale) return answer({ status: "not-found" })
        if (current.owner !== undefined && request.headers.get(TURN_OWNER_HEADER) !== current.owner) {
          return answer({ status: "forbidden" })
        }
        return answer({ status: "active", generation: current.generation })
      }
      case "/cancel": {
        if (!matches || current?.state !== "active" || stale) return answer({ status: "not-found" })
        if (current.owner !== undefined && request.headers.get(TURN_OWNER_HEADER) !== current.owner) {
          return answer({ status: "forbidden" })
        }
        await this.write("cancelled", current.generation, current.owner)
        return answer({ status: "cancelled" })
      }
      case "/settle": {
        if (!matches || current === undefined) return answer({ status: "not-found" })
        if (current.state !== "settled") await this.write("settled", current.generation, current.owner)
        return answer({ status: "settled" })
      }
      case "/state": {
        const effective: TurnCancelStateName | "unknown" = !matches || stale || current === undefined ? "unknown" : current.state
        return answer({ state: effective })
      }
      default:
        return new Response("not found", { status: 404 })
    }
  }
}

const turnCancelStub = (env: WorkerEnv, runId: string): TurnCancelStub =>
  env.TURN_CANCELS.get(env.TURN_CANCELS.idFromName(runId))

const readStubJson = async <T>(response: Response): Promise<T | undefined> =>
  (response.json().catch(() => undefined)) as Promise<T | undefined>

export interface WorkerEnv extends RecommendEnv, CloudRoleEnv {
  /** Trusted service implementing docs/browser-egress.md's pinned HTTPS transport. */
  readonly BROWSER_EGRESS?: { readonly fetch: (request: Request) => Promise<Response> }
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> }
  readonly SMITHERS_BUILD_SHA?: string
  readonly SMITHERS_CHAT_URL?: string
  readonly SMITHERS_CHAT_ORIGIN?: string
  /**
   * The deployment credential the chat upstream authenticates turns with
   * (`workers/chat` accepts only `authorization: Bearer`, resolved against
   * the cloud's /api/user). A client can never supply it — the turn route
   * builds its own headers — so without it the forward can only come back
   * the upstream's honest 401, which is surfaced verbatim.
   */
  readonly SMITHERS_CHAT_AUTH_TOKEN?: string
  /**
   * The chat worker's trusted-caller key (its PRODUCT_SERVICE_TOKEN). Sent
   * with the validated login on session-gated turns so the turn's metered
   * charge lands on the user's own account (wave 13, D-2).
   */
  readonly CHAT_PRODUCT_SERVICE_TOKEN?: string
  /**
   * How long any one upstream gets to return headers, in milliseconds.
   * Unset uses 20,000ms; a deployment behind a slow sibling can raise it
   * without a code change, and the tests shorten it to stay fast.
   */
  readonly UPSTREAM_TIMEOUT_MS?: string
  /** Identity worker (GitHub OAuth + allowlist) upstream. Unset = 501. */
  readonly IDENTITY_UPSTREAM_URL?: string
  /**
   * The Smithers GitHub App's numeric id (`smitherspreviewrelease`, 4163546).
   * With the private key below, the public catalog's stats reads authenticate
   * as the App's installation on the `smithersai` organization
   * (src/githubApp.ts) instead of as a person's token.
   */
  readonly SMITHERS_GITHUB_APP_ID?: string
  /**
   * The App's PEM private key, as GitHub issues it (PKCS#1,
   * `-----BEGIN RSA PRIVATE KEY-----`); a PKCS#8 key is accepted too. Unset —
   * or unimportable — the catalog reads fall back to the token below, and then
   * to an anonymous read.
   */
  readonly SMITHERS_GITHUB_APP_PRIVATE_KEY?: string
  /**
   * Optional GitHub token for the public catalog's stats reads
   * (src/publicRepos.ts). It overrides the GitHub App above when both are set.
   * Either credential raises GitHub's ceiling from 60 to 5000 requests an
   * hour; with neither, the reads go unauthenticated and a rate limit shows as
   * "Stats unavailable" on the landing page.
   */
  readonly GITHUB_TOKEN?: string
  /** Service token for the product-Worker → identity /api/identity/validate call. */
  readonly IDENTITY_SERVICE_TOKEN?: string
  /**
   * "1" opens the Stripe checkout and portal routes. Unset — the closed-alpha
   * state — makes both answer an honest refusal instead of reaching Stripe.
   */
  readonly BILLING_CHECKOUT_ENABLED?: string
  /** Billing worker upstream. Unset = 501. */
  readonly BILLING_UPSTREAM_URL?: string
  /**
   * The Smithers Cloud user bearer billing authenticates the account with
   * (`workers/billing` resolves it against `SMITHERS_CLOUD_API_BASE_URL/api/user`).
   * Billing reads no `x-user-*` claim, so without this the seam answers 501
   * rather than forwarding a request that can only come back 401.
   */
  readonly BILLING_AUTH_TOKEN?: string
  /**
   * The wave-5 trusted-caller key (`workers/billing`'s PRODUCT_SERVICE_TOKEN).
   * When a session validates, the billing proxy authenticates AS THAT USER with
   * `x-smithers-service-token` + `x-user-login` instead of the deployment-wide
   * bearer — the signed-in user reads their OWN account, never the shared one.
   */
  readonly BILLING_PRODUCT_SERVICE_TOKEN?: string
  /**
   * The admin tokens for the sibling workers' non-enumerable admin surfaces
   * (each sibling holds its own ADMIN_SERVICE_TOKEN). The product Worker's
   * /api/admin/* routes spend them only after the caller's session validates
   * as admin:true; every other caller gets the canonical 404.
   */
  readonly IDENTITY_ADMIN_TOKEN?: string
  readonly BILLING_ADMIN_TOKEN?: string
  /**
   * The per-runId cancellation registry (Durable Object). Bound on every real
   * deployment — wrangler.jsonc binds it, and tests drive the real class over
   * in-memory storage.
   */
  readonly TURN_CANCELS: TurnCancelNamespace
  /**
   * Smithers Cloud API base (Wave 11): the per-user gateway provision route
   * lives here (`POST /api/repos/{owner}/{repo}/gateway`).
   */
  readonly SMITHERS_CLOUD_API_BASE_URL?: string
  /**
   * The per-user gateway session registry (Wave 11, Durable Object keyed by
   * login): holds the relay records server-side so gateway tokens never
   * reach a browser, and coordinates provisioning so concurrent cold or
   * expired misses join one resolution. Bound on every real deployment;
   * tests drive the real class over in-memory storage.
   */
  readonly GATEWAY_SESSIONS: GatewaySessionNamespace
  /**
   * The per-login turn ceiling (Durable Object keyed by the validated login).
   * An abuse guard on a comped seam, not a billing pause — see turnLimit.ts.
   * Unset in unit tests and the stub stack, where it fails open.
   */
  readonly TURN_LIMITS?: TurnLimitNamespace
  /**
   * The salt under the anonymous turn buckets (turnLimit.ts
   * `anonymousTurnKey`): a deployment secret, so a bucket name is never a
   * reversible index of a visitor's address. Unset in unit tests and the
   * stub stack.
   */
  readonly ANONYMOUS_TURN_SALT?: string
  /**
   * The bounded client-error log (one Durable Object for the deployment),
   * read back through GET /api/admin/errors. Unset in unit tests, where the
   * handler keeps its console.error and nothing is stored.
   */
  readonly CLIENT_ERRORS?: ClientErrorNamespace
  /**
   * The command recommender's log (one Durable Object for the deployment),
   * read back through GET /api/admin/recommend/log. The Cerebras key and
   * model it also reads are declared on RecommendEnv (src/recommend.ts).
   */
  readonly RECOMMEND_LOG?: RecommendEnv["RECOMMEND_LOG"]
}

const withIsolationHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...ISOLATION_HEADERS }
  })

const isStartTurnRequest = (value: unknown): value is StartAgentTurnRequest =>
  typeof value === "object" &&
  value !== null &&
  "runId" in value &&
  typeof value.runId === "string" &&
  value.runId !== "" &&
  "messages" in value &&
  Array.isArray(value.messages) &&
  "instructions" in value &&
  typeof value.instructions === "string" &&
  (!("tools" in value) || Array.isArray(value.tools)) &&
  (!("context" in value) ||
    value.context === undefined ||
    AgentRuntimeContextSchema.safeParse(value.context).success)

const readTurnBody = async (request: Request): Promise<unknown> => {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_BODY_BYTES) throw new BodyTooLargeError()
  // Measured in bytes, not UTF-16 code units: a body of multi-byte characters
  // encodes to up to 4x its string length, so a `.length` check would admit a
  // body several times over the cap (and a chunked request declares no length).
  const reader = request.body?.getReader()
  const chunks: Array<Uint8Array> = []
  let byteLength = 0
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        throw new BodyTooLargeError()
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new Error("Request body must be valid JSON.")
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large.")
  }
}

/*
 * Every model call replays the whole transcript, so "too large" is a fact about
 * the CONVERSATION, not about the message that tripped it. The turn seam said
 * so; the model relay — which since the browser chain became the only backend
 * carries every turn — still answered the bare `Request body is too large.`,
 * which names nothing the reader can act on (repro
 * apps/ui/canary-repros/chat/4.13). One sentence, both doors.
 */
const TRANSCRIPT_TOO_LARGE =
  "This conversation has grown too long to send in one turn. Start a new conversation to keep going — nothing was charged, and the transcript above stays where it is."

/** How often the streaming pump re-checks the kill state while the upstream is silent. */
const CANCEL_POLL_MS = 500
const CANCEL_POLL_MAX_MS = 5000
// At most eight minutes of silent monitoring, below the stale registration
// window and with ample subrequests reserved for auth, inference and cleanup.
const CANCEL_POLL_LIMIT = 96

/**
 * The poll is a Durable Object subrequest, and a Worker request may only make
 * ~1000 of those — a token-streamed turn delivers far more chunks than that,
 * so polling once per chunk would kill long turns with "Too many subrequests".
 * The poll backs off during silence to CANCEL_POLL_MAX_MS. Also,
 * because workerd's clock only advances on I/O — at least one every
 * CANCEL_POLL_CHUNKS chunks, so a fast stream can never starve the check.
 */
const CANCEL_POLL_CHUNKS = 64

/**
 * The turn's own view of the kill state. `isCancelled` reads the runId's
 * Durable Object — every read is this request's own subrequest, which workerd
 * allows, unlike touching another request's AbortController. `settle` marks
 * the turn finished so a later cancel answers an honest not-found.
 */
interface TurnStreamHooks {
  readonly isCancelled?: () => Promise<boolean>
  readonly abort: (reason: string) => void
  readonly settle: () => Promise<void>
}

/**
 * Stamp each upstream frame with the turn's runId. The upstream wire frame
 * carries none (the dev boundary's CloudAgent adds it on publish; this Worker
 * is that boundary for the deployed app), and the client's stream reader
 * drops frames that don't name their turn — an untouched pass-through would
 * be a silent stall. Unparseable lines pass through verbatim.
 *
 * The terminal `done` frame also settles the kill state — here, while the
 * frame is still in the transform, never later: a tool-loop continuation leg
 * re-POSTs the same runId the instant the client reads that frame, and must
 * not meet a stale 409 from a registration the stream lifecycle hadn't
 * settled yet.
 *
 * A server-side kill surfaces between chunks: the pump re-reads the registry
 * before every upstream read and on a timer tick while the upstream is
 * silent, and on "cancelled" it aborts ITS OWN upstream fetch (legal — same
 * request context), emits an honest terminal `done` frame with reason
 * "cancelled", and closes. The turn never completes silently after a kill.
 */
const tagRunId = (
  body: ReadableStream<Uint8Array>,
  runId: string,
  hooks?: TurnStreamHooks,
  upstreamRunId?: string
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let settled = false
  // One pending upstream read at a time, held across pulls: a timer tick that
  // wins the race leaves the read in place for the next pull instead of
  // issuing a second read on the same reader (which would throw).
  let pendingRead:
    | Promise<ReadableStreamDefaultReadDoneResult | ReadableStreamDefaultReadValueResult<Uint8Array>>
    | undefined
  const settleOnce = async (): Promise<void> => {
    if (settled) return
    settled = true
    await hooks?.settle()
  }
  // Rate-limited kill check: skipped once the turn has settled (the registry
  // entry is then free for the next leg, and a later "cancelled" on it is not
  // this stream's business) and while neither the clock nor the chunk count
  // says another poll is due.
  let lastPollAt = 0
  let chunksSincePoll = CANCEL_POLL_CHUNKS
  let pollInterval = CANCEL_POLL_MS
  let polls = 0
  const killed = async (): Promise<"cancelled" | "limit" | "unavailable" | false> => {
    if (hooks?.isCancelled === undefined || settled) return false
    const now = Date.now()
    if (now - lastPollAt < pollInterval && chunksSincePoll < CANCEL_POLL_CHUNKS) return false
    if (polls >= CANCEL_POLL_LIMIT) return "limit"
    polls += 1
    lastPollAt = now
    chunksSincePoll = 0
    try {
      return await hooks.isCancelled() ? "cancelled" : false
    } catch (error) {
      console.error("turn registry state failed:", error)
      return "unavailable"
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const killedReason = await killed()
        if (killedReason) {
          hooks?.abort(killedReason)
          await reader.cancel(killedReason).catch((error) => console.error("turn upstream cancel failed:", error))
          await settleOnce()
          controller.enqueue(
            encoder.encode(`${JSON.stringify(killedReason === "cancelled"
              ? { runId, type: "done", reason: "cancelled" }
              : { runId, type: "done", reason: "stop", error: killedReason === "limit"
                ? "The turn exceeded its cancellation monitoring limit. Try again."
                : "The turn lost cancellation monitoring. Try again." })}\n`)
          )
          controller.close()
          return
        }
        pendingRead ??= reader.read()
        const read = pendingRead
        // The tick only bounds how long a silent upstream can hide a kill;
        // clear it as soon as the read wins so a chatty stream does not pile
        // up one live timer per chunk.
        let tick: ReturnType<typeof setTimeout> | undefined
        const result = await Promise.race([
          read,
          ...(hooks?.isCancelled === undefined || settled
            ? []
            : [
              new Promise<"tick">((resolve) => {
                tick = setTimeout(() => resolve("tick"), pollInterval)
              })
            ])
        ])
        if (tick !== undefined) clearTimeout(tick)
        if (result === "tick") {
          // Keep the pending read alive; returning without enqueueing would
          // leave a silent stream with no subsequent pull to run its timer.
          // Force the elapsed poll even as the next wait backs off.
          chunksSincePoll = CANCEL_POLL_CHUNKS
          pollInterval = Math.min(pollInterval * 2, CANCEL_POLL_MAX_MS)
          continue
        }
        pollInterval = CANCEL_POLL_MS
        pendingRead = undefined
        chunksSincePoll += 1
        const { value, done } = result
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split("\n")
        buffer = done ? "" : (lines.pop() ?? "")
        for (const line of lines) {
          if (line.trim() === "") continue
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            parsed = undefined
          }
          if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
            if ((parsed as { type?: unknown }).type === "done") await settleOnce()
            // Upstream-generated approvals can echo the charge id. Keep
            // those correlated with the client's turn as well; unrelated
            // workflow run identities inside cards remain untouched.
            const card = "card" in parsed ? parsed.card : undefined
            if (upstreamRunId !== undefined && typeof card === "object" && card !== null && "payload" in card) {
              const payload = card.payload
              if (typeof payload === "object" && payload !== null && "runId" in payload && payload.runId === upstreamRunId) {
                parsed = { ...parsed, card: { ...card, payload: { ...payload, runId } } }
              }
            }
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ ...(parsed as object), runId })}\n`)
            )
          } else {
            controller.enqueue(encoder.encode(`${line}\n`))
          }
        }
        if (done) {
          await settleOnce()
          controller.close()
          return
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return
      }
    },
    cancel: async (reason) => {
      hooks?.abort("client disconnected")
      await settleOnce()
      return reader.cancel(reason)
    }
  })
}

/**
 * Where managed inference lives, and how this Worker authenticates to it.
 *
 * Both model-spending routes — the turn path and the browser chain's relay —
 * call the SAME upstream with the SAME credentials, so there is one place that
 * decides what a Smithers-authenticated inference request looks like. The
 * upstream owns the provider key, prices the turn against the rate card, and
 * meters it durably; nothing downstream of here has to reproduce any of that.
 */
const chatUpstreamUrl = (env: WorkerEnv): string => env.SMITHERS_CHAT_URL?.trim() || DEFAULT_CHAT_URL

/*
 * Wave 13 (D-2): a session-validated call is metered onto the USER's own
 * billing account — the chat worker attributes the charge to the vouched login
 * (complimentary: cost recorded, $0 debited), so the user's receipt shows the
 * usage and their balance never moves. The token pair is the chat worker's
 * trusted-caller door; a client can never inject it, because this header set is
 * BUILT here and the caller's own headers are never forwarded. Without the
 * configured token the call still runs — metering then attributes to the
 * deployment account, exactly as before that path existed.
 */
const chatUpstreamHeaders = (
  env: WorkerEnv,
  runId: string,
  session: ValidatedIdentity | undefined
): Record<string, string> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: env.SMITHERS_CHAT_ORIGIN?.trim() || DEFAULT_APP_ORIGIN,
    "x-smithers-run-id": runId
  }
  const chatToken = env.SMITHERS_CHAT_AUTH_TOKEN?.trim()
  if (chatToken !== undefined && chatToken !== "") {
    headers.authorization = `Bearer ${chatToken}`
  }
  const chatProductToken = env.CHAT_PRODUCT_SERVICE_TOKEN?.trim()
  if (session !== undefined && chatProductToken !== undefined && chatProductToken !== "") {
    headers["x-smithers-service-token"] = chatProductToken
    headers["x-user-login"] = session.login
  }
  return headers
}

/** The turn request, or the refusal its body earns. Read once: the router reads it before the gate decides. */
const readStartTurn = async (request: Request): Promise<TurnRequest | Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    // The transcript rides every turn, so "too large" is a fact about the
    // conversation, not about this one message. Say which, and say the way out.
    if (error instanceof BodyTooLargeError) {
      return json(413, { status: "error", message: TRANSCRIPT_TOO_LARGE })
    }
    return json(400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  if (!isStartTurnRequest(body)) {
    return json(400, {
      status: "error",
      message: "Body must be { runId, messages, instructions } with optional tools and context."
    })
  }
  // The hints (tier, purpose, role) are read leniently: an unknown value is
  // dropped here, never refused (cloudRoleTurn.ts turnHints).
  return {
    runId: body.runId,
    messages: body.messages,
    instructions: body.instructions,
    ...(body.tools === undefined ? {} : { tools: body.tools }),
    ...(body.context === undefined ? {} : { context: body.context }),
    ...turnHints(body)
  }
}

interface TurnExecutionContext {
  readonly waitUntil: (promise: Promise<unknown>) => void
}

const handleTurn = async (
  request: Request,
  env: WorkerEnv,
  turnSession?: ValidatedIdentity,
  parsed?: TurnRequest,
  ctx?: TurnExecutionContext
): Promise<Response> => {
  const body = parsed ?? await readStartTurn(request)
  if (body instanceof Response) return body
  // A cloud role (librarian, flows) is answered here on Cerebras, never upstream.
  if (isCloudRoleTurn(body)) return handleCloudRoleTurn(body, env, ISOLATION_HEADERS, request.signal)
  const registry = turnCancelStub(env, body.runId)
  // The registry is the cross-isolate authority on duplicate turns.
  let registration: { status?: string; generation?: string } | undefined
  try {
    registration = await readStubJson<{ status?: string; generation?: string }>(
      await registry.fetch(
        new Request("https://turn-cancel.internal/register", {
          method: "POST",
          headers: turnSession === undefined ? {} : { [TURN_OWNER_HEADER]: turnSession.login }
        })
      )
    )
  } catch (error) {
    console.error("turn registry register failed:", error)
    return upstreamUnreachable("The turn registry", error)
  }
  if (registration?.status !== "started" || typeof registration.generation !== "string") {
    return json(409, { status: "error", message: "That Smithers turn is already running." })
  }
  const generation = registration.generation
  const upstream = new AbortController()
  const generationHeaders: Record<string, string> = { [TURN_GENERATION_HEADER]: generation }
  let settlement: Promise<void> | undefined
  const settle = (): Promise<void> => {
    if (settlement !== undefined) return settlement
    settlement = (async () => {
      try {
        const response = await registry.fetch(new Request("https://turn-cancel.internal/settle", {
          method: "POST", headers: generationHeaders
        }))
        if (!response.ok) throw new Error(`Registry settle returned ${response.status}`)
        await response.arrayBuffer()
      } catch (error) {
        console.error("turn registry settle failed:", error)
      }
    })()
    ctx?.waitUntil(settlement)
    return settlement
  }

  // Register cleanup before an aborted fetch can end the request context.
  const disconnect = () => {
    upstream.abort(request.signal.reason)
    void settle()
  }
  if (request.signal.aborted) disconnect()
  else request.signal.addEventListener("abort", disconnect, { once: true })

  const upstreamRunId = crypto.randomUUID()
  let response: Response
  try {
    response = await withDeadline("The model service", (signal) => fetch(chatUpstreamUrl(env), {
      method: "POST",
      signal,
      // The caller's id correlates frames and cancellation only. Every
      // inference request needs a server-owned charge id, including retries:
      // reusing a client id must never hide a second provider invocation.
      headers: chatUpstreamHeaders(env, upstreamRunId, turnSession),
      body: JSON.stringify({
        messages: body.messages,
        // The hidden runtime context renders server-side into the
        // instructions — same composition as the native/dev CloudAgent.
        instructions: composeAgentInstructions(body.instructions, body.context),
        // The tool-loop contract (Wave 3b): the one tool spec rides every
        // turn; the upstream emits tool_call frames the client answers
        // with function_call_output continuation items in `messages`.
        ...(body.tools === undefined ? {} : { tools: body.tools }),
        // The model hints ride the wire as the native CloudAgent sends them;
        // the upstream maps them to a model or answers on its default.
        ...(body.tier === undefined ? {} : { tier: body.tier }),
        ...(body.purpose === undefined ? {} : { purpose: body.purpose }),
        ...(body.role === undefined ? {} : { role: body.role })
      })
    }), upstreamTimeoutMs(env), upstream.signal)
  } catch (error) {
    await settle()
    if (error instanceof UpstreamTimeoutError) return upstreamUnreachable("The model service", error)
    if (upstream.signal.aborted) {
      return json(499, { status: "error", message: "The client disconnected." })
    }
    return json(502, {
      status: "error",
      message: `Smithers Cloud chat is unreachable: ${error instanceof Error ? error.message : "unknown error"}`
    })
  }
  if (!response.ok || response.body === null) {
    await settle()
    const detail = await response.text().catch(() => "")
    return json(response.ok ? 502 : response.status, {
      status: "error",
      message: response.ok
        ? "The model service accepted the turn and then sent no answer at all. Nothing was charged."
        : upstreamFailureMessage(response.status, detail, response.headers.get("retry-after"))
    })
  }

  // Stream the upstream NDJSON through with the run tagged on every frame so
  // the client can match it to its turn; a terminal frame, a kill observed
  // between chunks, or a closed connection settles the registry entry.
  const hooks: TurnStreamHooks = {
    isCancelled: async () => {
      const response = await registry.fetch(new Request("https://turn-cancel.internal/state", {
        headers: generationHeaders
      }))
      const state = await readStubJson<{ state?: string }>(response)
      if (!response.ok || state === undefined || !["active", "cancelled", "settled", "unknown"].includes(state.state ?? "")) {
        throw new Error("Invalid turn registry state response")
      }
      // A replaced registration must not leave its old upstream running.
      return state.state !== "active"
    },
    abort: (reason) => upstream.abort(reason),
    settle
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  void tagRunId(response.body, body.runId, hooks, upstreamRunId)
    .pipeTo(writable)
    .catch((error) => console.error("turn stream failed:", error))
    .finally(settle)
  return withIsolationHeaders(
    new Response(readable, {
      status: 200,
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" }
    })
  )
}

/*
 * The chain backend's model relay (DESIGN.md §14, D1) — and, since the browser
 * chain became the only backend, the one route a chat turn spends a model on.
 *
 * The browser runs the real @smthrs/model request/stream machinery against this
 * path and the relay forwards it, unchanged, to the SAME managed-inference
 * upstream `/api/agent/turn` uses (`chatUpstreamHeaders` above). That upstream
 * owns the metered provider keys, authorizes the balance BEFORE calling the
 * provider, and enqueues the turn's authoritative usage onto the durable
 * metering queue, so the relay inherits per-user metering rather than
 * reproducing it. The one provider credential this Worker does hold is the
 * free Cerebras key (CEREBRAS_API_KEY), spent only by the command recommender
 * (recommend.ts) and the cloud role turns (cloudRoleTurn.ts), never by this
 * relay.
 *
 * The router gates the route before any of this runs: anonymous callers get
 * 401, non-allowlisted ones 403, and the per-login turn ceiling applies — all
 * of it decided before a single upstream byte is spent.
 */

const isModelStreamBody = (value: unknown): value is { readonly messages: ReadonlyArray<unknown> } =>
  typeof value === "object" &&
  value !== null &&
  "messages" in value &&
  Array.isArray((value as { readonly messages?: unknown }).messages) &&
  (value as { readonly messages: ReadonlyArray<unknown> }).messages.length > 0

const hasTools = (value: object): boolean =>
  "tools" in value &&
  Array.isArray((value as { readonly tools?: unknown }).tools) &&
  ((value as { readonly tools: ReadonlyArray<unknown> }).tools.length > 0)

const handleModelStream = async (
  request: Request,
  env: WorkerEnv,
  session: ValidatedIdentity | undefined
): Promise<Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json(413, { status: "error", message: TRANSCRIPT_TOO_LARGE })
    }
    return json(400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  if (!isModelStreamBody(body)) {
    return json(400, { status: "error", message: "Body must carry a non-empty messages array." })
  }
  // The sealed-step law, enforced at the boundary: the author call carries no
  // tools, so a tool-bearing request has no business on this relay.
  if (hasTools(body)) {
    return json(400, { status: "error", message: "The model relay serves sealed author calls only — no tools." })
  }
  /*
   * The run id is minted HERE, never read from the caller. Upstream derives
   * the charge's idempotency key from it, so a client that could choose it
   * could replay one receipt and take every later call for free.
   */
  const runId = crypto.randomUUID()
  const upstream = new AbortController()
  if (request.signal.aborted) upstream.abort(request.signal.reason)
  else request.signal.addEventListener("abort", () => upstream.abort(request.signal.reason), { once: true })
  let response: Response
  try {
    response = await withDeadline("The model service", (signal) => fetch(chatUpstreamUrl(env), {
      method: "POST",
      signal,
      headers: chatUpstreamHeaders(env, runId, session),
      body: JSON.stringify(body)
    }), upstreamTimeoutMs(env), upstream.signal)
  } catch (error) {
    if (error instanceof UpstreamTimeoutError) return upstreamUnreachable("The model service", error)
    if (upstream.signal.aborted) {
      return json(499, { status: "error", message: "The client disconnected." })
    }
    return json(502, {
      status: "error",
      message: `The model service is unreachable: ${error instanceof Error ? error.message : "unknown error"}`
    })
  }
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => "")
    return json(response.ok ? 502 : response.status, {
      status: "error",
      message: response.ok
        ? "The model service accepted the request and then sent no answer at all."
        : upstreamFailureMessage(response.status, detail, response.headers.get("retry-after"))
    })
  }
  return withIsolationHeaders(
    new Response(response.body, {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/x-ndjson",
        "cache-control": "no-store"
      }
    })
  )
}

const handleCancel = async (
  request: Request,
  env: WorkerEnv,
  session: ValidatedIdentity | undefined
): Promise<Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  const runId = typeof body === "object" && body !== null && "runId" in body ? body.runId : undefined
  if (typeof runId !== "string" || runId === "") {
    return json(400, { status: "error", message: "runId is required." })
  }
  const registry = turnCancelStub(env, runId)
  // workerd-legal kill: never touch the turn request's I/O from here —
  // just flip the registry state. The turn's own streaming pump observes
  // "cancelled" between chunks and aborts its own upstream fetch, then
  // ends the stream with an honest terminal frame.
  let result: { status?: string } | undefined
  try {
    const headers = new Headers(session === undefined ? {} : { [TURN_OWNER_HEADER]: session.login })
    const current = await readStubJson<{ status?: string; generation?: string }>(
      await registry.fetch(new Request("https://turn-cancel.internal/current", { headers }))
    )
    if (current?.status === "forbidden") {
      return json(403, { status: "error", message: "That turn belongs to a different account." })
    }
    if (current?.status === "not-found") return json(200, { status: "not-found" })
    if (current?.status !== "active" || typeof current.generation !== "string") {
      throw new Error("Invalid turn registry current response")
    }
    headers.set(TURN_GENERATION_HEADER, current.generation)
    result = await readStubJson<{ status?: string }>(
      await registry.fetch(
        new Request("https://turn-cancel.internal/cancel", {
          method: "POST",
          headers
        })
      )
    )
  } catch (error) {
    console.error("turn registry cancel failed:", error)
    return upstreamUnreachable("The turn registry", error)
  }
  if (result?.status === "forbidden") {
    return json(403, { status: "error", message: "That turn belongs to a different account." })
  }
  return json(200, { status: result?.status === "cancelled" ? "cancelled" : "not-found" })
}

const notConfigured = (name: string, detail: string): Response =>
  json(501, { status: "error", message: `${name} is not configured on this deployment (${detail}).` })

const retiredGatewayProxy = (): Response => json(410, {
  status: "error",
  code: "gateway_proxy_removed",
  message: "The static gateway proxy was removed. Use the session-validated /api/workflow/provision and /api/workflow/rpc routes, or connect directly to a separately authenticated gateway."
})

const isRetiredGatewayRoute = (pathname: string): boolean =>
  RETIRED_GATEWAY_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

/**
 * A proxy whose upstream never answered. Returning the raw rejection would end
 * the fetch handler with an uncaught exception, and workerd answers that with
 * its own `Error 1101 Worker threw exception` HTML page — which the transcript
 * then renders verbatim to the user (repro apps/ui/canary-repros/honesty/24.3,
 * the §24.4 note). A named JSON refusal is the honest answer instead.
 */
const upstreamUnreachable = (seam: string, error: unknown): Response =>
  json(error instanceof UpstreamTimeoutError ? 504 : 502, {
    status: "error",
    message: error instanceof UpstreamTimeoutError
      ? `${error.message} Try again in a moment.`
      : `${seam} is unreachable right now: ${error instanceof Error ? error.message : "unknown error"}`
  })

/** Forward one already-built request under the seam's deadline, never throwing. */
const forwardUnderDeadline = (seam: string, target: Request, timeoutMs: number): Promise<Response> =>
  withDeadline(seam, (signal) => fetch(target, { signal }), timeoutMs, target.signal).catch((error: unknown) =>
    upstreamUnreachable(seam, error)
  )

/**
 * The identity worker is the identity authority: it sets and reads its own
 * session cookie, so the proxy forwards cookies untouched but still strips
 * client-supplied identity headers — a browser must never inject x-user-*.
 *
 * Both sibling workers gate on the browser `Origin` (`ALLOWED_ORIGINS`), and a
 * same-origin GET carries none at all, so the proxy states the one origin that
 * is actually true of every request it forwards: its own. Deployments must list
 * this Worker's origin in the identity and billing workers' `ALLOWED_ORIGINS`.
 */
const withProxyOrigin = (headers: Headers, url: URL): void => {
  headers.set("origin", url.origin)
}

const proxyToIdentity = (request: Request, env: WorkerEnv): Promise<Response> => {
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") {
    return Promise.resolve(
      notConfigured("The identity seam", "IDENTITY_UPSTREAM_URL is unset. Sign-in is unavailable")
    )
  }
  const url = new URL(request.url)
  if (siblingAdminRoute(url.pathname)) return Promise.resolve(notFound())
  const target = new URL(url.pathname + url.search, upstream)
  const headers = new Headers(request.headers)
  for (const name of STRIPPED_IDENTITY_HEADERS) headers.delete(name)
  withProxyOrigin(headers, url)
  return forwardUnderDeadline(
    "The identity service",
    new Request(target.toString(), new Request(request, { headers })),
    upstreamTimeoutMs(env)
  )
}

/*
 * Wave 8 — no dead ends on the live surface.
 *
 * The OAuth start/callback routes are TOP-LEVEL PAGE NAVIGATIONS: the user
 * clicks "Sign in with GitHub" and the browser loads the route as a document.
 * When the identity upstream answers anything but a redirect (OAuth
 * unconfigured → 503, an upstream 4xx/5xx, an unreachable service), passing
 * the response through would strand the user on a browser-rendered blob of
 * raw JSON — an error that says neither what they were doing nor the next
 * step. So at this seam a non-redirect upstream answer becomes a minimal,
 * self-contained branded page that states honestly what happened and offers
 * the one way back home. Callers that ask for JSON (`Accept:
 * application/json`) keep the machine-readable upstream answer verbatim, and
 * the HTTP status is preserved either way.
 *
 * The heading/detail strings below are constants composed with an integer
 * status code, plus — on the OAuth refusal path — GitHub's `error` and
 * `error_description` query params. Those two are attacker-controllable (any
 * site can link a user at the callback with a crafted query string), so they
 * are HTML-escaped at interpolation time in oauthCallbackRefusal below; no
 * user input reaches the page raw.
 */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char)

const prefersJson = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? ""
  return accept.includes("application/json") && !accept.includes("text/html")
}

const authErrorPage = (heading: string, detail: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${heading} — Smithers</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
	margin: 0;
	min-height: 100vh;
	display: grid;
	place-items: center;
	background: #f7f4ee;
	color: #211d18;
	font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	-webkit-font-smoothing: antialiased;
}
.card {
	max-width: 30rem;
	margin: 1.5rem;
	padding: 2.5rem 2.25rem;
	background: #fffefa;
	border: 1px solid #e4ddcf;
	border-radius: 16px;
	box-shadow: 0 1px 2px rgb(33 29 24 / 4%), 0 12px 32px rgb(33 29 24 / 10%);
}
.wordmark {
	margin: 0 0 1.75rem;
	font-size: 0.7813rem;
	font-weight: 600;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: #0f766e;
}
.wordmark::after {
	content: "";
	display: block;
	width: 2rem;
	height: 2px;
	margin-top: 0.5rem;
	background: #e8a33d;
	border-radius: 999px;
}
h1 {
	margin: 0 0 0.875rem;
	font-size: 1.375rem;
	line-height: 1.35;
	font-weight: 650;
}
.detail {
	margin: 0 0 2rem;
	font-size: 0.9375rem;
	line-height: 1.6;
	color: #4a443b;
}
.home {
	display: inline-block;
	padding: 0.625rem 1.25rem;
	border-radius: 10px;
	background: #0f766e;
	color: #fffefa;
	font-size: 0.9375rem;
	font-weight: 600;
	text-decoration: none;
}
.home:hover { background: #0b5b57; }
</style>
</head>
<body>
<main class="card">
<p class="wordmark">Smithers</p>
<h1>${heading}</h1>
<p class="detail">${detail}</p>
<a class="home" href="/">Back to Smithers</a>
</main>
</body>
</html>`

const authErrorResponse = (status: number, heading: string, detail: string): Response =>
  new Response(authErrorPage(heading, detail), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...ISOLATION_HEADERS
    }
  })

const OAUTH_OFF_HEADING = "GitHub sign-in isn't switched on yet for this preview."

/*
 * GitHub reports a refused authorization on the callback as `?error=…` with no
 * `code`. Forwarded to identity, that reads as a malformed callback and the
 * page told the user "the sign-in service answered HTTP 400" — blaming a
 * service for a button the user pressed (repro
 * apps/ui/canary-repros/access/2.3). The cause is knowable from the query
 * string, so it is read here and named.
 *
 * `access_denied` is not a failure: the user declined, the app did exactly what
 * it was told, and nothing was signed in. It answers 200 with that sentence.
 * Every other documented OAuth error IS a failure of the exchange and keeps a
 * 400 with the error GitHub named.
 */
const OAUTH_DENIED_HEADING = "You cancelled the GitHub sign-in."

const oauthCallbackRefusal = (url: URL): { status: number; heading: string; detail: string } | undefined => {
  const error = url.searchParams.get("error")?.trim()
  if (error === undefined || error === "") return undefined
  if (error === "access_denied") {
    return {
      status: 200,
      heading: OAUTH_DENIED_HEADING,
      detail:
        "You chose not to give Smithers access on GitHub, so the sign-in stopped there. Nothing was signed in and nothing was shared — head back whenever you want to try again."
    }
  }
  const described = url.searchParams.get("error_description")?.trim()
  // Both query params are interpolated into the branded HTML error page, so
  // they are escaped HERE, at interpolation time — the page design is
  // untouched and markup in a crafted callback URL renders as inert text.
  return {
    status: 400,
    heading: "GitHub sign-in didn't finish.",
    detail: `GitHub stopped the sign-in and called it "${escapeHtml(error)}"${
      described === undefined || described === "" ? "" : ` — ${escapeHtml(described)}`
    }. Nothing was signed in — head back and try again.`
  }
}

/*
 * The return path. A sign-in started from a repository page
 * (`/smithersai/smithers`) finished on the landing page, because the identity
 * worker knows one landing (`/?signed-in=github`) and this Worker forwarded
 * the callback's answer untouched. The page that asked travels as
 * `?return_to=` on the start route; this Worker (never the identity worker,
 * which cannot know this origin's pages) keeps it in a short-lived cookie
 * scoped to the two OAuth legs and, once identity answers the callback with
 * its success redirect, sends the browser back to that page with the same
 * `signed-in=github` marker the landing page would have carried.
 *
 * SECURITY. `return_to` is attacker-controllable (any site can link a user at
 * the start route with a crafted query string) and the callback turns it into
 * a redirect, which is the open-redirect shape. It is accepted only as a
 * same-origin absolute path: one leading slash; no scheme, host, or second
 * slash (`//evil` and `/\evil` both resolve off-origin in browsers); no
 * backslash, control character, or newline anywhere (header injection); at
 * most 512 bytes; never an `/api/` route (a page, not a redirect loop). The
 * value is re-validated when the cookie is read, so a tampered cookie is
 * ignored the same way a crafted query is. Anything rejected is dropped and
 * the callback lands where it always did.
 */
const RETURN_TO_COOKIE = "smithers_return_to"
const RETURN_TO_COOKIE_PATH = "/api/auth"
const RETURN_TO_MAX_AGE_SECONDS = 10 * 60
const RETURN_TO_MAX_BYTES = 512
const RETURN_TO_CONTROL = /[\u0000-\u001f\u007f\\]/

/** The same-origin page path `value` names, or undefined when it is anything else. */
const validReturnTo = (value: string | null | undefined): string | undefined => {
  if (typeof value !== "string" || value === "" || value === "/") return undefined
  if (new TextEncoder().encode(value).byteLength > RETURN_TO_MAX_BYTES) return undefined
  if (!value.startsWith("/") || value.startsWith("//") || RETURN_TO_CONTROL.test(value)) return undefined
  if (value.startsWith("/api/") || value === "/api") return undefined
  // Belt and braces: the URL parser must agree the path stays on this origin.
  const probe = "https://return-to.invalid"
  let resolved: URL
  try {
    resolved = new URL(value, probe)
  } catch {
    return undefined
  }
  if (resolved.origin !== probe || !resolved.pathname.startsWith("/")) return undefined
  return value
}

const returnToCookie = (value: string | undefined): string =>
  value === undefined
    ? `${RETURN_TO_COOKIE}=; Path=${RETURN_TO_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
    : `${RETURN_TO_COOKIE}=${encodeURIComponent(value)}; Path=${RETURN_TO_COOKIE_PATH}; Max-Age=${RETURN_TO_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`

/** The validated return path the request's cookie carries, or undefined. */
const readReturnToCookie = (request: Request): string | undefined => {
  const header = request.headers.get("cookie")
  if (header === null) return undefined
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== RETURN_TO_COOKIE) continue
    const raw = part.slice(eq + 1).trim()
    try {
      return validReturnTo(decodeURIComponent(raw))
    } catch {
      return undefined
    }
  }
  return undefined
}

const hasReturnToCookie = (request: Request): boolean =>
  (request.headers.get("cookie") ?? "").split(";").some((part) => part.trim().startsWith(`${RETURN_TO_COOKIE}=`))

const withSetCookie = (response: Response, cookie: string, location?: string): Response => {
  const headers = new Headers(response.headers)
  headers.append("set-cookie", cookie)
  if (location !== undefined) headers.set("location", location)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * The page the callback sends the browser to: the return path plus the marker
 * the identity redirect carried (`signed-in=github` today), or that marker
 * verbatim when identity's redirect carried none.
 */
const returnToLocation = (returnTo: string, upstreamLocation: string, requestUrl: URL): string => {
  const target = new URL(returnTo, requestUrl.origin)
  let upstream: URL | undefined
  try {
    upstream = new URL(upstreamLocation, requestUrl.origin)
  } catch {
    upstream = undefined
  }
  if (upstream !== undefined && upstream.origin === requestUrl.origin) {
    for (const [name, value] of upstream.searchParams) target.searchParams.set(name, value)
  }
  if (!target.searchParams.has(AUTH_SIGNED_IN_PARAM)) target.searchParams.set(AUTH_SIGNED_IN_PARAM, "github")
  return `${target.pathname}${target.search}${target.hash}`
}

const handleAuthNavigation = async (
  request: Request,
  env: WorkerEnv,
  route: "start" | "callback"
): Promise<Response> => {
  // The start leg reads the page that asked and keeps it out of the forwarded
  // query: the identity worker has no use for it, and GitHub must never see it.
  let returnTo: string | undefined
  if (route === "start") {
    const url = new URL(request.url)
    if (url.searchParams.has(AUTH_RETURN_TO_PARAM)) {
      returnTo = validReturnTo(url.searchParams.get(AUTH_RETURN_TO_PARAM))
      url.searchParams.delete(AUTH_RETURN_TO_PARAM)
      request = new Request(url.toString(), request)
    }
  } else {
    returnTo = readReturnToCookie(request)
  }
  if (route === "callback") {
    const refusal = oauthCallbackRefusal(new URL(request.url))
    if (refusal !== undefined) {
      if (prefersJson(request)) {
        return json(refusal.status, {
          status: refusal.status === 200 ? "cancelled" : "error",
          message: refusal.detail
        })
      }
      return authErrorResponse(refusal.status, refusal.heading, refusal.detail)
    }
  }
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") {
    if (prefersJson(request)) return proxyToIdentity(request, env)
    return authErrorResponse(
      501,
      OAUTH_OFF_HEADING,
      "You tried to sign in with GitHub, but this preview deployment has no sign-in service configured yet, so the sign-in can't start. Nothing was signed in and nothing was lost."
    )
  }
  let response: Response
  try {
    response = await proxyToIdentity(request, env)
  } catch (error) {
    const cause = error instanceof Error ? error.message : "unknown error"
    if (prefersJson(request)) {
      return json(502, { status: "error", message: `The identity service is unreachable: ${cause}` })
    }
    return authErrorResponse(
      502,
      route === "start" ? "GitHub sign-in can't start right now." : "GitHub sign-in didn't finish.",
      `You tried to sign in with GitHub, but the sign-in service could not be reached, so the sign-in ${
        route === "start" ? "can't start" : "could not complete"
      }. Nothing was signed in — head back and try again in a bit.`
    )
  }
  // The happy path is a redirect: to GitHub from start, back here from callback.
  const location = response.headers.get("location")
  if (response.status >= 300 && response.status < 400 && location !== null) {
    if (route === "start") {
      return returnTo === undefined ? response : withSetCookie(response, returnToCookie(returnTo))
    }
    // Identity's success redirect names its one landing; with a return path
    // on file the browser goes back to the page that asked instead, and the
    // cookie is spent either way.
    if (returnTo !== undefined) {
      return withSetCookie(response, returnToCookie(undefined), returnToLocation(returnTo, location, new URL(request.url)))
    }
    return hasReturnToCookie(request) ? withSetCookie(response, returnToCookie(undefined)) : response
  }
  /*
   * The OTHER happy path (native sign-in handoff): a callback bound to a
   * handoff answers a 200 HTML page — "You're signed in — return to the
   * Smithers app" — because the session travels to the app through the
   * claim endpoint, not this tab. A success page is not an upstream error;
   * replacing it with the 502 surface told a signed-in user nothing was
   * signed in (the live bug).
   */
  if (
    route === "callback" &&
    response.status === 200 &&
    (response.headers.get("content-type") ?? "").includes("text/html")
  ) {
    return response
  }
  if (prefersJson(request)) return response
  // What remains is an upstream error (or a non-redirect oddity): read the
  // machine answer for its code, then replace it with the human page.
  const body = (await response.text().catch(() => "")).trim()
  let code: string | undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === "object" && parsed !== null && "code" in parsed && typeof parsed.code === "string") {
      code = parsed.code
    }
  } catch {
    // A non-JSON error body has no code to read; the status still says enough.
  }
  const status = response.status >= 400 ? response.status : 502
  if (route === "start") {
    if (code === "oauth_not_configured") {
      return authErrorResponse(
        status,
        OAUTH_OFF_HEADING,
        `You tried to sign in with GitHub. The sign-in service answered that its GitHub credentials aren't installed yet (HTTP ${status}), so the sign-in can't start. Nothing was signed in and nothing was lost.`
      )
    }
    return authErrorResponse(
      status,
      "GitHub sign-in can't start right now.",
      `You tried to sign in with GitHub, but the sign-in service answered HTTP ${status} instead of sending you to GitHub, so the sign-in can't start. Nothing was signed in — head back and try again in a bit.`
    )
  }
  return authErrorResponse(
    status,
    "GitHub sign-in didn't finish.",
    `You were on your way back from GitHub, but the sign-in service answered HTTP ${status}, so the sign-in could not complete. Nothing was signed in — head back and try again.`
  )
}

/**
 * Wave 8 — the session probe is a question, not an error. The landing boots by
 * asking "who is signed in?", and the upstream's 401 IS the expected signed-out
 * answer — but the browser logs any 4xx document/subresource response as a
 * console error no matter how calmly the client JS handles it. So the seam
 * restates the expected answer as what it honestly is — a resolved 200 naming
 * the signed-out state.
 *
 * ONLY the 401. The identity worker spends 401 on exactly one thing here (no
 * session cookie, or an unreadable one); its 403 means "Forbidden origin" — a
 * deployment whose ALLOWED_ORIGINS omits this Worker, where every identity call
 * is broken and nobody could sign in. Restating that as "signed out" would
 * paint a broken deployment as a calm signed-out landing with a clean console,
 * which is exactly the kind of suppression this wave exists to stop. It, 5xx,
 * and an unreachable upstream all pass through untouched and still surface.
 */
const probeAuthSession = async (request: Request, env: WorkerEnv): Promise<Response> => {
  const response = await proxyToIdentity(request, env)
  if (response.status !== 401) return response
  await response.body?.cancel()
  return json(200, { status: "signed-out" })
}

interface ValidatedIdentity {
  readonly login: string
  readonly allowlisted: boolean
  readonly admin: boolean
  readonly scopes: ReadonlyArray<string>
}

type SessionValidation =
  | { readonly status: "valid"; readonly identity: ValidatedIdentity }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable"; readonly response: Response }

/**
 * Validate the caller's session cookie against the identity worker's
 * service-token endpoint (the contract's trusted-proxy validation path).
 * Keeps an invalid session distinct from an unavailable identity service so
 * an outage can never be restated as "Sign in".
 */
const validateSession = async (request: Request, env: WorkerEnv): Promise<SessionValidation> => {
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") return { status: "invalid" }
  const headers: Record<string, string> = { "content-type": "application/json" }
  const cookie = request.headers.get("cookie")
  if (cookie !== null) headers.cookie = cookie
  const serviceToken = env.IDENTITY_SERVICE_TOKEN?.trim()
  if (serviceToken !== undefined && serviceToken !== "") {
    headers["x-smithers-service-token"] = serviceToken
  }
  try {
    const response = await withDeadline(
      "The identity service",
      (signal) =>
        fetch(new URL("/api/identity/validate", upstream).toString(), {
          method: "POST",
          headers,
          body: "{}",
          signal
        }),
      upstreamTimeoutMs(env)
    )
    if (!response.ok) {
      await response.body?.cancel()
      return response.status === 401
        ? { status: "invalid" }
        : {
          status: "unavailable",
          response: json(502, { status: "error", message: `The identity service answered HTTP ${response.status}.` })
        }
    }
    const body = (await response.json().catch(() => undefined)) as {
      login?: unknown
      allowlisted?: unknown
      admin?: unknown
      scopes?: unknown
    } | undefined
    if (body === undefined || typeof body.login !== "string" || body.login === "") {
      // Identity answers a cookieless validate with a session body that has
      // no login. That is a signed-out visitor, not a malformed answer, and
      // the 401 is what opens the anonymous catalog door
      // (anonymousCatalogTurn). A loginless body for a request that DID
      // send a cookie is still identity misbehaving.
      if (cookie === null && body !== undefined) return { status: "invalid" }
      return {
        status: "unavailable",
        response: json(502, { status: "error", message: "The identity service returned a malformed session response." })
      }
    }
    return {
      status: "valid",
      identity: {
        login: body.login,
        allowlisted: body.allowlisted === true,
        admin: body.admin === true,
        scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : []
      }
    }
  } catch (error) {
    return {
      status: "unavailable",
      response: json(error instanceof UpstreamTimeoutError ? 504 : 502, {
        status: "error",
        message: error instanceof UpstreamTimeoutError
          ? error.message
          : "The identity service is unreachable."
      })
    }
  }
}

/**
 * The turn seam spends the deployment's own model credential and meters real
 * dollars onto the deployment's billing account, so on any deployment that HAS
 * an identity seam it must never answer an anonymous caller. The same-origin
 * guard is not that gate: it only fires for a request that *sends* an `Origin`,
 * so a plain `curl -X POST` sails past it. Wave 7 published this Worker at
 * canary.smithers.sh, where that made `/api/agent/turn` a world-reachable spend.
 *
 * When IDENTITY_UPSTREAM_URL is unset there is no seam that could authenticate
 * anyone (the local dev/stub stack, the e2e), so the gate stays out of the way.
 *
 * The one exception is decided by the router, not here: a signed-out turn
 * about a public catalog repository (`anonymousCatalogTurn`) runs under the
 * anonymous per-address ceiling. Every other route keeps this 401.
 */
const requireTurnSession = async (
  request: Request,
  env: WorkerEnv
): Promise<Response | ValidatedIdentity | undefined> => {
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") return undefined
  const validation = await validateSession(request, env)
  if (validation.status === "unavailable") return validation.response
  if (validation.status === "invalid") {
    return json(401, { status: "error", message: "Sign in to run a Smithers turn." })
  }
  const session = validation.identity
  if (!session.allowlisted) {
    return json(403, {
      status: "error",
      message: "This account is not in the closed-alpha allowlist yet."
    })
  }
  return session
}

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
const proxyToBilling = async (request: Request, env: WorkerEnv): Promise<Response> => {
  const upstream = env.BILLING_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") {
    return notConfigured("The billing seam", "BILLING_UPSTREAM_URL is unset. Balance is unavailable")
  }
  const url = new URL(request.url)
  if (siblingAdminRoute(url.pathname)) return notFound()
  const target = new URL(url.pathname + url.search, upstream)
  const headers = new Headers(request.headers)
  for (const name of STRIPPED_IDENTITY_HEADERS) headers.delete(name)

  const validation = await validateSession(request, env)
  if (validation.status === "unavailable") return validation.response
  if (validation.status === "valid") {
    const session = validation.identity
    const serviceToken = env.BILLING_PRODUCT_SERVICE_TOKEN?.trim()
    if (serviceToken === undefined || serviceToken === "") {
      return notConfigured(
        "The billing seam",
        "BILLING_PRODUCT_SERVICE_TOKEN is unset. A signed-in user's balance reads through the trusted-caller path; without it the seam could only bill the shared deployment account, so it says so instead"
      )
    }
    headers.set("x-smithers-service-token", serviceToken)
    headers.set("x-user-login", session.login)
    headers.set("x-user-id", session.login)
    headers.set("x-user-role", session.admin ? "admin" : "member")
    if (session.scopes.length > 0) headers.set("x-user-scopes", session.scopes.join(" "))
  } else {
    if (env.IDENTITY_UPSTREAM_URL?.trim()) {
      return json(401, {
        status: "error",
        message: "Sign in before reading your balance — the identity service did not validate a session."
      })
    }
    const bearer = env.BILLING_AUTH_TOKEN?.trim()
    if (bearer === undefined || bearer === "") {
      return notConfigured(
        "The billing seam",
        "BILLING_AUTH_TOKEN is unset. Billing authenticates the account with a Smithers Cloud user bearer, and no other credential opens it"
      )
    }
    headers.set("authorization", `Bearer ${bearer}`)
  }
  withProxyOrigin(headers, url)
  return forwardUnderDeadline(
    "The billing service",
    new Request(target.toString(), new Request(request, { headers })),
    upstreamTimeoutMs(env)
  )
}

/*
 * The canonical unknown-route answer. The admin surface is non-enumerable
 * (Launch Checklist §E): a non-admin — or signed-out — caller probing
 * /api/admin/* gets EXACTLY this response, byte-identical to any other
 * unknown /api/* route. Never 401, never 403, never a different shape.
 */
const notFound = (): Response => json(404, { status: "error", message: "Not found." })

/** Forward an admin upstream call, passing the upstream status and body through verbatim. */
const forwardAdminCall = async (
  upstream: string,
  path: string,
  adminToken: string,
  init: { method: string; body?: unknown },
  timeoutMs: number
): Promise<Response> => {
  const headers: Record<string, string> = { "x-smithers-admin-token": adminToken }
  if (init.body !== undefined) headers["content-type"] = "application/json"
  let response: Response
  try {
    response = await withDeadline("The admin upstream", (signal) =>
      fetch(new URL(path, upstream).toString(), {
        method: init.method,
        headers,
        signal,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
      }), timeoutMs)
  } catch (error) {
    return upstreamUnreachable("The admin upstream", error)
  }
  const text = await response.text()
  return new Response(text, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", ...ISOLATION_HEADERS }
  })
}

const adminTokenNotConfigured = (name: string, envName: string): Response =>
  notConfigured(name, `${envName} is unset. The admin surface is unavailable on this deployment`)

interface AdminServiceHealth {
  readonly name: string
  readonly status: "ok" | "failed" | "unconfigured"
  readonly detail: string
}

/** One honest per-service line for admin.health — a real healthz read or the truth about why not. */
const readServiceHealth = async (
  name: string,
  upstream: string | undefined,
  envName: string,
  summarize: (body: Record<string, unknown>) => string,
  timeoutMs: number
): Promise<AdminServiceHealth> => {
  const base = upstream?.trim()
  if (base === undefined || base === "") {
    return { name, status: "unconfigured", detail: `${envName} is unset on this deployment.` }
  }
  let response: Response
  try {
    response = await withDeadline(name, (signal) => fetch(new URL("/healthz", base).toString(), { signal }), timeoutMs)
  } catch (error) {
    return {
      name,
      status: "failed",
      detail: error instanceof UpstreamTimeoutError
        ? error.message
        : `unreachable: ${error instanceof Error ? error.message : "unknown error"}`
    }
  }
  if (!response.ok) {
    await response.body?.cancel()
    return { name, status: "failed", detail: `healthz answered HTTP ${response.status}.` }
  }
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (body === undefined) return { name, status: "failed", detail: "healthz did not return JSON." }
  if (body.ok !== true) return { name, status: "failed", detail: "healthz reported not ok." }
  return { name, status: "ok", detail: summarize(body) }
}

/**
 * "What failed overnight?" v1: compose the health card's facts from real
 * reads — each sibling's /healthz, the billing ledger's charge totals, and
 * the request-access queue depth. A service that cannot be read says so;
 * nothing is invented.
 */
const handleAdminHealth = async (env: WorkerEnv, proxyOrigin: string): Promise<Response> => {
  const summarize = (...fields: ReadonlyArray<string>) => (body: Record<string, unknown>): string => {
    const parts = fields
      .filter((field) => body[field] !== undefined)
      .map((field) => `${field}: ${JSON.stringify(body[field])}`)
    return parts.length === 0 ? "healthz ok." : `healthz ok — ${parts.join(" · ")}`
  }
  const [billing, identity] = await Promise.all([
    readServiceHealth(
      "billing",
      env.BILLING_UPSTREAM_URL,
      "BILLING_UPSTREAM_URL",
      summarize("rateCardVersion", "resources", "unpricedActiveResources"),
      upstreamTimeoutMs(env)
    ),
    readServiceHealth(
      "identity",
      env.IDENTITY_UPSTREAM_URL,
      "IDENTITY_UPSTREAM_URL",
      summarize("requestedScopes", "admin", "serviceToken"),
      upstreamTimeoutMs(env)
    )
  ])

  /*
   * Recent charges: the billing ledger's own totals, read with the account
   * bearer — which authenticates the DEPLOYMENT's billing account, not the
   * fleet. Since wave 13 a signed-in user's turn is metered onto that user's
   * own account, so this figure stopped moving and is smaller than a single
   * active user's (repro apps/ui/canary-repros/admin/25.7). Billing keeps one
   * Durable Object per login with no enumeration, so no fleet total can be
   * read from here at all; the answer therefore STATES its scope instead of
   * presenting a deployment figure as a fleet one.
   */
  let charges: {
    chargeCount: number
    lifetimeChargedUsd: string
    scope: string
    scopeDetail: string
  } | null = null
  const billingBase = env.BILLING_UPSTREAM_URL?.trim()
  const bearer = env.BILLING_AUTH_TOKEN?.trim()
  if (billingBase !== undefined && billingBase !== "" && bearer !== undefined && bearer !== "") {
    try {
      // Billing refuses a request that carries no Origin, so the read states
      // this Worker's own — the same seam discipline as the billing proxy.
      const balance = await withDeadline(
        "billing",
        (signal) =>
          fetch(new URL("/api/billing/balance", billingBase).toString(), {
            headers: { authorization: `Bearer ${bearer}`, origin: proxyOrigin },
            signal
          }),
        upstreamTimeoutMs(env)
      )
      if (balance.ok) {
        const body = (await balance.json()) as {
          balance?: { chargeCount?: unknown; lifetimeChargedUsd?: unknown }
        }
        if (
          typeof body.balance?.chargeCount === "number" &&
          typeof body.balance.lifetimeChargedUsd === "string"
        ) {
          charges = {
            chargeCount: body.balance.chargeCount,
            lifetimeChargedUsd: body.balance.lifetimeChargedUsd,
            scope: "deployment-account",
            scopeDetail:
              "charge rows on the deployment's own billing account. Signed-in users' turns meter onto their own accounts, so this is not a fleet total and it is not a turn count."
          }
        }
      } else {
        await balance.body?.cancel()
      }
    } catch {
      // charges stays null — the card says "no charge read" rather than inventing one.
    }
  }

  // Request-queue depth: the identity admin read, or null when it can't be had.
  let queueDepth: number | null = null
  const identityBase = env.IDENTITY_UPSTREAM_URL?.trim()
  const identityAdmin = env.IDENTITY_ADMIN_TOKEN?.trim()
  if (identityBase !== undefined && identityBase !== "" && identityAdmin !== undefined && identityAdmin !== "") {
    try {
      const queue = await withDeadline("identity", (signal) =>
        fetch(new URL("/api/identity/admin/requests", identityBase).toString(), {
          headers: { "x-smithers-admin-token": identityAdmin },
          signal
        }), upstreamTimeoutMs(env))
      if (queue.ok) {
        const body = (await queue.json()) as { requests?: unknown }
        if (Array.isArray(body.requests)) queueDepth = body.requests.length
      } else {
        await queue.body?.cancel()
      }
    } catch {
      // queueDepth stays null — honest absence, not a zero.
    }
  }

  return json(200, {
    services: [billing, identity],
    charges,
    queueDepth,
    checkedAt: new Date().toISOString()
  })
}

/** The caller-owned idempotency key of one confirmed grant: the UI sends its confirmation card id. */
const GRANT_OPERATION_KEY = /^[A-Za-z0-9_-]{8,64}$/
const GRANT_OPERATION_KEY_GRAMMAR = "of 8 to 64 letters, digits, '_' or '-'"
const grantIdOf = (operationKey: string): string => `admin:product-${operationKey}`

/**
 * Read one grant from the recipient's ledger, keyed by the grant id billing
 * dedups on. This is the trusted-caller balance read (service token +
 * x-user-login, see proxyToBilling), so it needs BILLING_PRODUCT_SERVICE_TOKEN.
 * Returns the credit row, undefined when absent, or the refusal to send.
 */
const readAdminGrant = async (
  env: WorkerEnv,
  upstream: string,
  proxyOrigin: string,
  login: string,
  grantId: string
): Promise<Record<string, unknown> | undefined | Response> => {
  const serviceToken = env.BILLING_PRODUCT_SERVICE_TOKEN?.trim()
  if (serviceToken === undefined || serviceToken === "") {
    return notConfigured(
      "The billing seam",
      "BILLING_PRODUCT_SERVICE_TOKEN is unset. A grant is checked against the recipient's ledger before it posts, and that read needs the trusted-caller token"
    )
  }
  let response: Response
  try {
    response = await withDeadline("The billing service", (signal) =>
      fetch(new URL("/api/billing/balance", upstream).toString(), {
        headers: {
          "x-smithers-service-token": serviceToken,
          "x-user-login": login,
          "x-user-id": login,
          "x-user-role": "member",
          origin: proxyOrigin
        },
        signal
      }), upstreamTimeoutMs(env))
  } catch (error) {
    return upstreamUnreachable("The billing service", error)
  }
  if (!response.ok) {
    return json(502, {
      status: "error",
      message: `The billing service refused the ledger read for ${login} (HTTP ${response.status}), so the grant was not posted.`
    })
  }
  const ledger = (await response.json().catch(() => undefined)) as { credits?: unknown } | undefined
  const credits = Array.isArray(ledger?.credits) ? ledger.credits : []
  return credits.find((credit): credit is Record<string, unknown> =>
    typeof credit === "object" && credit !== null && (credit as { id?: unknown }).id === grantId)
}

const parseAdminBody = async (request: Request): Promise<Record<string, unknown> | Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json(400, { status: "error", message: "Body must be a JSON object." })
  }
  return body as Record<string, unknown>
}

/**
 * The admin plugin's server half (Launch Checklist §E). Every /api/admin/*
 * route FIRST validates the session through identity and requires BOTH
 * admin:true and allowlisted:true; anything else gets the canonical 404,
 * byte-identical to an unknown route. Admin writes carry their audit
 * attribution at write time: requester is the admin's own validated login and
 * the timestamp is fresh — the siblings refuse unattributed writes by contract.
 *
 * Allowlisted is part of the gate because removing a login from the
 * closed-alpha allowlist has to revoke something. It did not: `admin` comes
 * from identity's ADMIN_LOGINS var, so a de-allowlisted admin kept the whole
 * surface — including POST /api/admin/allowlist, the door that edits the
 * allowlist itself (repro apps/ui/canary-repros/access/1.5). Identity now
 * withholds the claim from a non-allowlisted login too; this check is the
 * second half of that fix, so the product Worker refuses on its own evidence
 * rather than trusting one upstream field.
 */
const handleAdmin = async (request: Request, env: WorkerEnv, url: URL): Promise<Response> => {
  const validation = await validateSession(request, env)
  if (validation.status === "unavailable") return validation.response
  if (validation.status === "invalid") return notFound()
  const session = validation.identity
  if (!session.admin || !session.allowlisted) return notFound()

  if (url.pathname === ADMIN_ALLOWLIST_PATH && request.method === "POST") {
    const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
    if (upstream === undefined || upstream === "") {
      return notConfigured("The identity seam", "IDENTITY_UPSTREAM_URL is unset. The allowlist is unavailable")
    }
    const token = env.IDENTITY_ADMIN_TOKEN?.trim()
    if (token === undefined || token === "") {
      return adminTokenNotConfigured("The identity admin surface", "IDENTITY_ADMIN_TOKEN")
    }
    const body = await parseAdminBody(request)
    if (body instanceof Response) return body
    const login = typeof body.login === "string" ? body.login.trim() : ""
    const action = body.action
    if (login === "" || (action !== "add" && action !== "remove")) {
      return json(400, { status: "error", message: "Body must be { login, action: \"add\" | \"remove\" }." })
    }
    /*
     * An admin cannot remove its own login. Now that being allowlisted is
     * what carries admin, a self-removal is a one-way door: it revokes the
     * session's admin claim, and the only door that could undo it is this
     * one. The first caller to try it would lock the closed alpha's admin
     * surface out of the product with no in-app way back — the operator's
     * ADMIN_SERVICE_TOKEN would be the only remaining route. Refuse, and
     * name the route that does work.
     */
    if (action === "remove" && login.toLowerCase() === session.login.toLowerCase()) {
      return json(409, {
        status: "error",
        message:
          "You can't remove your own login from the allowlist: it would revoke your admin access through the only door that could restore it. Ask another admin to remove you, or use the identity worker's admin token."
      })
    }
    return forwardAdminCall(upstream, "/api/identity/admin/allowlist", token, {
      method: "POST",
      body: { login, action, requester: session.login, timestamp: new Date().toISOString() }
    }, upstreamTimeoutMs(env))
  }

  if (url.pathname === ADMIN_GRANT_PATH && request.method === "GET") {
    const upstream = env.BILLING_UPSTREAM_URL?.trim()
    if (upstream === undefined || upstream === "") {
      return notConfigured("The billing seam", "BILLING_UPSTREAM_URL is unset. Grants are unavailable")
    }
    const login = url.searchParams.get("login")?.trim() ?? ""
    const operationKey = url.searchParams.get("operationKey") ?? ""
    if (login === "" || !GRANT_OPERATION_KEY.test(operationKey)) {
      return json(400, { status: "error", message: `Query must carry login and operationKey ${GRANT_OPERATION_KEY_GRAMMAR}.` })
    }
    const grantId = grantIdOf(operationKey)
    const existing = await readAdminGrant(env, upstream, url.origin, login, grantId)
    if (existing instanceof Response) return existing
    return json(200, existing === undefined
      ? { found: false, grantId, userId: login }
      : { found: true, grantId, userId: login, grant: existing })
  }

  if (url.pathname === ADMIN_GRANT_PATH && request.method === "POST") {
    const upstream = env.BILLING_UPSTREAM_URL?.trim()
    if (upstream === undefined || upstream === "") {
      return notConfigured("The billing seam", "BILLING_UPSTREAM_URL is unset. Grants are unavailable")
    }
    const token = env.BILLING_ADMIN_TOKEN?.trim()
    if (token === undefined || token === "") {
      return adminTokenNotConfigured("The billing admin surface", "BILLING_ADMIN_TOKEN")
    }
    const body = await parseAdminBody(request)
    if (body instanceof Response) return body
    const login = typeof body.login === "string" ? body.login.trim() : ""
    const amountUsd = typeof body.amountUsd === "number" ? body.amountUsd : Number.NaN
    const operationKey = typeof body.operationKey === "string" ? body.operationKey : ""
    if (login === "" || !Number.isFinite(amountUsd) || amountUsd <= 0 || !GRANT_OPERATION_KEY.test(operationKey)) {
      return json(400, {
        status: "error",
        message:
          `Body must be { login, amountUsd, operationKey } with a positive dollar amount and an operationKey ${GRANT_OPERATION_KEY_GRAMMAR}.`
      })
    }
    /*
     * The grant id is derived from the caller's operation key, never minted
     * here: a confirmation retried after a lost billing response carries the
     * same key, so billing deduplicates it by grantId instead of crediting a
     * second time (review app-server/api-design/1). The recipient's ledger is
     * read first so a key reused for a different amount, or by a different
     * admin, is refused instead of silently answering with the old credit.
     * Without the trusted-caller token that read cannot happen; the stable
     * grant id alone still keeps a retry from crediting twice, so the grant
     * posts and only the conflict check is skipped.
     */
    const grantId = grantIdOf(operationKey)
    const canReadLedger = (env.BILLING_PRODUCT_SERVICE_TOKEN?.trim() ?? "") !== ""
    const existing = canReadLedger ? await readAdminGrant(env, upstream, url.origin, login, grantId) : undefined
    if (existing instanceof Response) return existing
    if (existing !== undefined) {
      const grantedUsd = typeof existing.grantedUsd === "string" ? Number(existing.grantedUsd) : Number.NaN
      const sameAmount = Number.isFinite(grantedUsd) && Math.abs(grantedUsd - amountUsd) < 0.005
      const sameRequester = existing.requestedBy === session.login
      if (!sameAmount || !sameRequester) {
        return json(409, {
          status: "error",
          message:
            `Operation ${operationKey} already granted $${Number.isFinite(grantedUsd) ? grantedUsd.toFixed(2) : "?"} to ${login}` +
            ` (requested by ${typeof existing.requestedBy === "string" ? existing.requestedBy : "unknown"}).` +
            " Start a new grant for a different amount instead of reusing this confirmation."
        })
      }
      return json(200, { granted: true, duplicate: true, grantId, userId: login, grant: existing })
    }
    return forwardAdminCall(upstream, "/api/billing/admin/grants", token, {
      method: "POST",
      body: {
        userId: login,
        grantId,
        amountUsd,
        kind: "promotional",
        requester: session.login,
        timestamp: new Date().toISOString()
      }
    }, upstreamTimeoutMs(env))
  }

  if (url.pathname === ADMIN_REQUESTS_PATH && request.method === "GET") {
    const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
    if (upstream === undefined || upstream === "") {
      return notConfigured("The identity seam", "IDENTITY_UPSTREAM_URL is unset. The request queue is unavailable")
    }
    const token = env.IDENTITY_ADMIN_TOKEN?.trim()
    if (token === undefined || token === "") {
      return adminTokenNotConfigured("The identity admin surface", "IDENTITY_ADMIN_TOKEN")
    }
    return forwardAdminCall(upstream, "/api/identity/admin/requests", token, { method: "GET" }, upstreamTimeoutMs(env))
  }

  if (url.pathname === ADMIN_HEALTH_PATH && request.method === "GET") {
    return handleAdminHealth(env, url.origin)
  }

  // The client-error log, newest first. No upstream and no admin token: the
  // reports are this Worker's own state, so this is a local read, and it
  // answers an empty log honestly rather than 404ing when nothing has broken.
  if (url.pathname === ADMIN_ERRORS_PATH && request.method === "GET") {
    const asked = Number(url.searchParams.get("limit") ?? "")
    const limit = Number.isInteger(asked) && asked > 0 ? asked : undefined
    const log = await readClientErrors(env.CLIENT_ERRORS, limit)
    return json(200, {
      status: "ok",
      total: log.total,
      reports: log.reports,
      ...(log.note === undefined ? {} : { note: log.note }),
      ...(env.CLIENT_ERRORS === undefined
        ? { note: "No CLIENT_ERRORS binding on this deployment: nothing is stored, so this log is always empty." }
        : {})
    })
  }

  // The recommendation log, newest first: what the recommender said and what
  // the user ran next. The scorer reads it; nothing here holds chat text.
  if (url.pathname === ADMIN_RECOMMEND_LOG_PATH && request.method === "GET") {
    const asked = Number(url.searchParams.get("limit") ?? "")
    const limit = Number.isInteger(asked) && asked > 0 ? asked : undefined
    const rows = await readRecommendLog(env.RECOMMEND_LOG, limit)
    return json(200, {
      status: "ok",
      rows,
      ...(env.RECOMMEND_LOG === undefined
        ? { note: "No RECOMMEND_LOG binding on this deployment: nothing is stored, so this log is always empty." }
        : {})
    })
  }

  // An admin-only path this Worker does not implement is still just not found.
  return notFound()
}

/*
 * Wave 11 — "make me a workflow": the per-user gateway seam, live.
 *
 * The browser drives /api/workflow/*; the Worker resolves the caller's
 * session, mints (or reuses) their Smithers Cloud identity through the
 * identity worker's cloud-token door, provisions-or-resumes the workspace
 * gateway for a WATCHED repo (the watched set is the universe — the client
 * routes anything outside it to the chooser), and relays RPC/event calls
 * with the gateway token it alone holds.
 */

/*
 * owner/repo — the shape the Cloud provision route takes; anything else (a dot
 * segment that URL parsing would resolve away included) is refused pre-upstream
 * by `isRelayRepoName`.
 */

/**
 * The workflow seam spends the user's own workspace resources, so on any
 * deployment that HAS an identity seam it requires a validated, allowlisted
 * session — the same gate as a turn. Returns the validated identity or the
 * refusal response.
 */
const requireWorkflowSession = async (
  request: Request,
  env: WorkerEnv
): Promise<ValidatedIdentity | Response> => {
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") {
    return notConfigured(
      "The workflow seam",
      "IDENTITY_UPSTREAM_URL is unset. The per-user gateway needs a validated session, and no identity service can provide one"
    )
  }
  const validation = await validateSession(request, env)
  if (validation.status === "unavailable") return validation.response
  if (validation.status === "invalid") {
    return json(401, { status: "error", message: "Sign in to run workflows on your workspace." })
  }
  const session = validation.identity
  if (!session.allowlisted) {
    return json(403, {
      status: "error",
      message: "This account is not in the closed-alpha allowlist yet."
    })
  }
  return session
}

/** The typed, non-gateway answers a gateway call can produce, in one place. */
const gatewayCallResponse = (call: Awaited<ReturnType<typeof callGateway>>): Response => {
  if (call.status === "ok") return call.response
  if (call.status === "provisioning") return json(200, { status: "provisioning", message: call.detail })
  if (call.status === "no_capacity") return json(200, { status: "no-capacity", message: call.detail })
  if (call.status === "no_cloud_token") return json(200, { status: "no-cloud-identity", message: call.detail })
  if (call.status === "no_cloud_repo") return json(200, { status: "no-cloud-repo", message: call.detail })
  return json(502, { status: "error", message: call.detail })
}

const parseWorkflowRepo = (value: unknown): string | undefined =>
  typeof value === "string" && isRelayRepoName(value) ? value : undefined

const handleWorkflowProvision = async (request: Request, env: WorkerEnv): Promise<Response> => {
  const session = await requireWorkflowSession(request, env)
  if (session instanceof Response) return session
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  const repo = typeof body === "object" && body !== null && "repo" in body
    ? parseWorkflowRepo((body as { repo?: unknown }).repo)
    : undefined
  if (repo === undefined) {
    return json(400, { status: "error", message: "Body must be { repo } as owner/repo." })
  }
  const workspaceId = (body as { workspaceId?: unknown }).workspaceId
  if (workspaceId !== undefined && !isGatewayWorkspaceId(workspaceId)) {
    return json(400, { status: "error", message: "workspaceId must be a canonical workspace UUID." })
  }
  const outcome = await ensureGateway(env, session.login, repo, false, workspaceId)
  switch (outcome.status) {
    case "ready":
      // The token NEVER leaves the server: the answer names the gateway and
      // its re-resolve cadence, nothing more.
      return json(200, {
        status: "ready",
        repo,
        gatewayId: outcome.record.gatewayId,
        ...(outcome.record.workspaceId === undefined ? {} : { workspaceId: outcome.record.workspaceId }),
        expiresAt: new Date(outcome.record.expiresAt).toISOString()
      })
    case "provisioning":
      return json(200, { status: "provisioning", message: outcome.detail })
    case "no_capacity":
      return json(200, { status: "no-capacity", message: outcome.detail })
    case "no_cloud_token":
      return json(200, { status: "no-cloud-identity", message: outcome.detail })
    case "no_cloud_repo":
      // §4: a watched repo with no Cloud counterpart — a state of its own.
      return json(200, { status: "no-cloud-repo", message: outcome.detail })
    default:
      return json(502, { status: "error", message: outcome.detail })
  }
}

/**
 * Relay one call to the caller's own workspace gateway.
 *
 * The body names the repo (which per-user gateway to reach), the procedure
 * (what is being called), and its payload. The Worker refuses a procedure the
 * product does not relay before spending anything, writes the gateway's RPC
 * frame for it, adds the bearer credential a browser can never hold, and
 * answers the gateway's own outcome unwrapped.
 */
const handleWorkflowRpc = async (request: Request, env: WorkerEnv): Promise<Response> => {
  const session = await requireWorkflowSession(request, env)
  if (session instanceof Response) return session
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  const candidate = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined
  const repo = parseWorkflowRepo(candidate?.repo)
  const procedure = typeof candidate?.procedure === "string" ? candidate.procedure : ""
  if (repo === undefined || procedure === "") {
    return json(400, { status: "error", message: "Body must be { repo, procedure, payload? }." })
  }
  const workspaceId = candidate?.workspaceId
  if (workspaceId !== undefined && !isGatewayWorkspaceId(workspaceId)) {
    return json(400, { status: "error", message: "workspaceId must be a canonical workspace UUID." })
  }
  const mount = GATEWAY_PROCEDURE_MOUNTS[procedure]
  if (mount === undefined) {
    return json(400, { status: "error", message: `The workflow seam does not relay ${procedure}.` })
  }
  const call = await callGateway(env, session.login, repo, mount, {
    method: "POST",
    workspaceId,
    text: encodeGatewayRequest(procedure, candidate?.payload),
    replayable: !NON_REPLAYABLE_GATEWAY_PROCEDURES.includes(procedure)
  })
  if (call.status !== "ok") return gatewayCallResponse(call)
  const text = await call.response.text()
  // A gateway that answered at the HTTP level but not with a frame is still a
  // refusal the client can render, never a 500 from this Worker.
  const frame = call.response.status === 200
    ? decodeGatewayResponse(text)
    : { ok: false as const, error: { message: `The workspace answered HTTP ${call.response.status}.` } }
  return json(200, frame)
}

/**
 * The live dispatchers of one repository (workflowTriggers.ts). The declared
 * rules ride the public contents route, so this route is only the box's
 * answer: a signed-in, allowlisted session that already holds a live box gets
 * that box's `List { _tag: "triggers" }` page; everyone and everything else
 * gets `live: false` with empty lists, as a 200. The relay runs with
 * `provision: false`, so a read never provisions a box, never re-mints a
 * Cloud token, and never resumes a suspended VM: no record, a record past its
 * half-life, a 401, or a tunnel failure are all just `live: false`. The
 * repository is validated before any session is checked, so a malformed name
 * is a 400 for every caller.
 */
const handleWorkflowTriggers = async (request: Request, env: WorkerEnv, url: URL): Promise<Response> => {
  const repo = parseWorkflowRepo(url.searchParams.get("repo") ?? undefined)
  if (repo === undefined) {
    return json(400, { status: "error", message: "Query must name the repository as ?repo=owner/repo." })
  }
  const session = await requireWorkflowSession(request, env)
  if (session instanceof Response) return json(200, noLiveTriggers(repo))
  const call = await callGateway(env, session.login, repo, GATEWAY_PROCEDURE_MOUNTS.List ?? "/rpc", {
    method: "POST",
    text: encodeGatewayRequest("List", LIST_TRIGGERS_PAYLOAD),
    provision: false
  })
  if (call.status !== "ok" || call.response.status !== 200) {
    if (call.status === "ok") await call.response.body?.cancel()
    return json(200, noLiveTriggers(repo))
  }
  return json(200, workflowTriggersFromFrame(repo, decodeGatewayResponse(await call.response.text())))
}

const isApiRoute = (pathname: string): boolean => pathname.startsWith("/api/") || isRetiredGatewayRoute(pathname)

/*
 * The browser tool's fetch route (Wave 10, §2d): server-side, hard-guarded
 * (https only, public hosts only after DNS resolution, size cap, timeout, no
 * cookies, declared user-agent). Session-gated exactly like a turn — the
 * deployment's network egress is a resource — and read-tier: it changes
 * nothing upstream.
 */
const handleBrowserFetch = async (request: Request, env: WorkerEnv): Promise<Response> => {
  let body: unknown
  try {
    body = await readTurnBody(request)
  } catch (error) {
    return json(error instanceof BodyTooLargeError ? 413 : 400, {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid request."
    })
  }
  const url = typeof body === "object" && body !== null && "url" in body && typeof body.url === "string"
    ? body.url
    : undefined
  if (url === undefined || url.trim() === "") {
    return json(400, { status: "error", message: "Body must be { url }." })
  }
  const egress = env.BROWSER_EGRESS
  if (egress === undefined) {
    return json(501, { status: "error", message: "Web page reading is unavailable on this host. Open it in the native app." })
  }
  const outcome = await browserFetch(url.trim(), {
    resolveHost: resolveHostOverHttps,
    fetchImpl: (target, init, address) => egress.fetch(new Request("https://browser-egress.internal/fetch", {
      method: "POST",
      redirect: "manual",
      signal: init.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1, url: target, address, method: "GET",
        headers: Object.fromEntries(new Headers(init.headers))
      })
    }))
  })
  return json(outcome.ok ? 200 : 422, browserFetchResponseBody(outcome))
}

/**
 * Same-origin guard for the API surface. These routes spend the deployment's
 * own credentials — `/api/workflow/rpc` relays a gateway procedure under the
 * credential the Worker holds and the browser never sees — and a `text/plain`
 * or form POST from another site is not preflighted, so nothing else would
 * stop a page anywhere from driving them. Requests without an `Origin` (same-origin GETs, top-level OAuth
 * navigation, curl, the e2e) are untouched.
 */
const isCrossOriginRequest = (request: Request, url: URL): boolean => {
  const origin = request.headers.get("origin")
  return origin !== null && origin !== url.origin
}

/*
 * The curated platform proxy (MULTI-ACTIONS-GAP.md Tier 1/2): the browser
 * calls these paths same-origin; the Worker validates the session, mints the
 * user's own Smithers Cloud token (the same per-user door the gateway seam
 * uses), and forwards with that bearer. An ALLOWLIST, never a wildcard —
 * every proxied family is one the product ships commands for. Note
 * /api/billing/checkout|portal are EXACT matches routed to the platform's
 * Stripe seam; the rest of /api/billing/* stays with the product billing
 * worker below.
 *
 * Exported for the host parity matrix (apps/ui/docs/web-mode/PLAN.md §6):
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
   * apps/ui/src/mainview/state/seams calls today: the bridge hands the page
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
 * apps/ui/canary-repros/money/17.4). A configuration string is not an answer to
 * "upgrade my plan", and a live checkout call is not something an MVP account
 * should be able to make at all.
 *
 * Set BILLING_CHECKOUT_ENABLED=1 on the deployment where paid plans ship; the
 * routes then forward exactly as before.
 */
const CHECKOUT_PATHS: ReadonlyArray<string> = ["/api/billing/checkout", "/api/billing/portal"]

const checkoutEnabled = (env: WorkerEnv): boolean => env.BILLING_CHECKOUT_ENABLED?.trim() === "1"

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

/*
 * Frontend error ingest (multi's /api/client-errors, minimal form): bounded
 * body, logged to the worker tail, kept in the client-error log. The
 * throttle is the log's own (clientErrorLog.ts): a counter here would be per
 * isolate, and workerd runs as many isolates as a flood asks for.
 */
const CLIENT_ERRORS_PATH = "/api/client-errors"
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

/**
 * Read a body under its byte cap: a declared content-length over the cap
 * is refused before a byte is read, and a chunked body (which declares no
 * length) is cut off the moment the running byte count crosses it — the same
 * discipline readTurnBody keeps. Returns undefined when the cap is exceeded.
 */
const readBoundedBody = async (request: Request, limit: number): Promise<ArrayBuffer | undefined> => {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > limit) return undefined
  const reader = request.body?.getReader()
  const chunks: Array<Uint8Array> = []
  let byteLength = 0
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > limit) {
        await reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}

const handleClientError = async (request: Request, env: WorkerEnv): Promise<Response> => {
  const body = await readBoundedBody(request, CLIENT_ERROR_MAX_BODY)
  if (body === undefined) {
    return json(413, { status: "error", message: "Error report too large." })
  }
  const text = new TextDecoder().decode(body)
  // The log is what makes an alpha user's crash readable afterwards, through
  // GET /api/admin/errors; it is bounded, it decides the throttle, and it
  // never fails the report. console.error alone lives exactly as long as
  // someone is tailing, so a throttled report is not worth a tail line.
  const referer = request.headers.get("referer")
  const userAgent = request.headers.get("user-agent")
  const outcome = await appendClientError(
    env.CLIENT_ERRORS,
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
  console.error("client-error:", text)
  return json(202, { status: "accepted" })
}

const platformProxyMatch = (pathname: string, method: string): boolean =>
  PLATFORM_PROXY_RULES.some(
    (rule) =>
      rule.methods.includes(method) &&
      (rule.exact !== undefined
        ? pathname === rule.exact
        : rule.prefix !== undefined && pathname.startsWith(rule.prefix))
  )

const handlePlatformProxy = async (request: Request, env: WorkerEnv, url: URL): Promise<Response> => {
  const publicRead = isPublicRepositoryRead(request.method, url.pathname)
  const publicAnswer = async () => {
    const response = await readPublicRepository(url, env.SMITHERS_CLOUD_API_BASE_URL?.trim() || DEFAULT_CLOUD_API_BASE_URL)
    if (response.ok) return response
    const failure = json(response.status, {
      status: "error", message: platformFailureMessage(response.status, await response.text().catch(() => ""))
    })
    failure.headers.set("cache-control", "private, no-store")
    const vary = response.headers.get("vary")
    if (vary !== null) failure.headers.set("vary", vary)
    return failure
  }
  if (publicRead && !request.headers.has("cookie")) return withIsolationHeaders(await publicAnswer())
  const gate = await requireTurnSession(request, env)
  if (publicRead && (gate === undefined || (gate instanceof Response && (gate.status === 401 || gate.status === 403)))) {
    return withIsolationHeaders(await publicAnswer())
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
  if (CHECKOUT_PATHS.includes(url.pathname) && !checkoutEnabled(env)) {
    return json(501, {
      status: "error",
      message:
        "There is nothing to buy during the closed alpha: your balance is comped, so there is no checkout and no billing portal. You'll be told before that changes."
    })
  }
  const token = await fetchCloudToken(env, gate.login)
  if (token.status !== "ok") {
    return json(503, {
      status: "error",
      message: `Smithers Cloud isn't reachable for your account right now (${token.status}).`
    })
  }
  let body: ArrayBuffer | undefined
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await readBoundedBody(request, platformBodyLimit(url.pathname, request.method))
    if (body === undefined) {
      return json(413, { status: "error", message: "Request body too large." })
    }
  }
  const base = env.SMITHERS_CLOUD_API_BASE_URL?.trim() || DEFAULT_CLOUD_API_BASE_URL
  // The path is joined onto the platform's origin and must still be there
  // once parsed: a bearer never leaves for any other host.
  const target = new URL(url.pathname + url.search, base)
  if (target.origin !== new URL(base).origin) return notFound()
  const headers = new Headers({ authorization: `Bearer ${token.token}` })
  const contentType = request.headers.get("content-type")
  if (contentType !== null) headers.set("content-type", contentType)
  const accept = request.headers.get("accept")
  if (accept !== null) headers.set("accept", accept)
  let upstream: Response
  try {
    upstream = await withDeadline(
      "Smithers Cloud",
      (signal) =>
        fetch(target.toString(), {
          method: request.method,
          headers,
          signal,
          ...(body === undefined ? {} : { body })
        }),
      upstreamTimeoutMs(env)
    )
  } catch (error) {
    return upstreamUnreachable("Smithers Cloud", error)
  }
  /*
   * A failure never passes through: the upstream's body is written for its
   * own callers, and the product renders whatever comes back straight to the
   * user. Restate it in the seam's own envelope so a reader always gets a
   * sentence, and the shape matches every other refusal this Worker makes.
   */
  if (upstream.status >= 400) {
    const detail = await upstream.text().catch(() => "")
    return json(upstream.status, { status: "error", message: platformFailureMessage(upstream.status, detail) })
  }
  // Status and body pass through; upstream headers do not (no set-cookie, no
  // upstream CORS) — only the content type survives.
  const out = new Headers()
  out.set("cache-control", "private, no-store")
  const upstreamType = upstream.headers.get("content-type")
  if (upstreamType !== null) out.set("content-type", upstreamType)
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

/*
 * The `/api/cloud/<inner>` bridge (apps/ui/docs/web-mode/PLAN.md §0
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

const handleCloudProxy = async (request: Request, env: WorkerEnv, url: URL): Promise<Response> => {
  const inner = cloudInnerUrl(url)
  if (inner === undefined || !platformProxyMatch(inner.pathname, request.method)) return notFound()
  return handlePlatformProxy(request, env, inner)
}

/*
 * The app under the apex. The product for a repository lives at
 * https://smithers.sh/<owner>/<name>, a page the smithers.sh Astro build
 * (apps/site) prerenders per catalog repository and this Worker serves from
 * that build's dist. wrangler.jsonc routes only the owner prefixes below to
 * this Worker on the apex and runs it first for them, so this handler, not the
 * assets layer, decides what a repository path answers: a catalog repository's
 * page is the app document with the isolation headers OPFS needs, and every
 * other path under a routed owner is nobody's page, so it leaves for the site
 * instead of a 404 page. The owner list mirrors the `smithers.sh/<owner>/*`
 * routes and the `run_worker_first` entries in wrangler.jsonc: a new owner
 * needs all three in one commit (src/workerIdentity.test.ts holds the last two
 * to this list).
 */
export const ROUTED_OWNER_PREFIXES: ReadonlyArray<string> = ["/smithersai/"]

/** Whether `owner/name` is in the public catalog; GitHub names are case-insensitive. */
const isCatalogRepository = (name: unknown): boolean =>
  typeof name === "string" && AVAILABLE_REPOS.some((repo) => repo.name.toLowerCase() === name.toLowerCase())

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
const anonymousCatalogTurn = async (request: Request, env: WorkerEnv, refusal: Response, ctx?: TurnExecutionContext): Promise<Response> => {
  const body = await readStartTurn(request)
  if (body instanceof Response) return body
  if (!isCatalogRepository(body.context?.activeRepository)) return refusal
  const budget = await spendTurn(
    env.TURN_LIMITS,
    await anonymousTurnKey(request, env.ANONYMOUS_TURN_SALT),
    ANONYMOUS_CEILING
  )
  if (!budget.allowed) return turnLimitResponse(budget, ISOLATION_HEADERS, ANONYMOUS_CEILING)
  // Spent after the address bucket admits, so a visitor who is already at
  // their own ceiling never draws down everyone's.
  const shared = await spendTurn(env.TURN_LIMITS, ANONYMOUS_ALL_KEY, ANONYMOUS_ALL_CEILING)
  if (!shared.allowed) return turnLimitResponse(shared, ISOLATION_HEADERS, ANONYMOUS_ALL_CEILING)
  return handleTurn(request, env, undefined, body, ctx)
}

const handlePublicRepoActivity = createPublicRepoActivityHandler({
  fetch: (request) => fetch(request),
  now: () => Date.now(),
  cache: () => (globalThis as typeof globalThis & { caches?: CacheStorage & { default?: Cache } }).caches?.default
})

/**
 * What a repository path answers. A coming-soon repository (COMING_SOON_REPOS)
 * has a prerendered site page and no app. wrangler runs the Worker first for
 * its owner (COMING_SOON_WORKER_FIRST in wrangler.jsonc), so this branch sees
 * the canonical path and the variants the assets have no file for, and
 * `/effect-ts/effect` reaches the same page instead of the 404 page. A catalog
 * repository under a routed owner is the app document; every other path under
 * a routed owner is nobody's page.
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

/*
 * The app document, fetched from the site build by its canonical path
 * (src/appDocument.ts) and served with the isolation headers the app's OPFS
 * persistence needs. Only the app document carries them: the docs pages in
 * the same build load Google Fonts and Pagefind, which COEP require-corp
 * would block.
 */
const serveAppDocument = async (request: Request, env: WorkerEnv, url: URL, document: string): Promise<Response> =>
  withIsolationHeaders(await env.ASSETS.fetch(new Request(new URL(document, url).toString(), request)))

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

const worker = {
  async fetch(request: Request, env: WorkerEnv, ctx?: TurnExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    // This one curated, read-only catalog is public to the marketing site.
    // Every authenticated API continues through the same-origin guard below.
    if (url.pathname === PUBLIC_REPOS_PATH) return handlePublicRepos(request, env)
    // The catalog's recent-activity sentence (src/publicRepoActivity.ts): a
    // public read computed from the Cloud mirror, never from GitHub.
    if (parsePublicRepoActivityPath(url.pathname) !== undefined) {
      return handlePublicRepoActivity(request, env.SMITHERS_CLOUD_API_BASE_URL?.trim() || DEFAULT_CLOUD_API_BASE_URL)
    }
    // Retired mounts never forward, even on WebSocket upgrade or when legacy
    // deployment credentials are still configured.
    const retiredGatewayRoute = isRetiredGatewayRoute(url.pathname)
    if (isApiRoute(url.pathname) && isCrossOriginRequest(request, url)) {
      return json(403, {
        status: "error",
        message: "This API only answers requests from its own origin."
      })
    }
    // The command recommender (src/recommend.ts): open to a visitor as well
    // as a login, under its own ceilings. A login is the bucket when the
    // session validates; anything else, including identity being down, is
    // the visitor's address bucket, because the pills must never wait on
    // sign-in and never spend a real model turn.
    if (url.pathname === RECOMMEND_PATH || url.pathname === RECOMMEND_OUTCOME_PATH) {
      if (request.method !== "POST") return json(405, { status: "error", message: "Method not allowed." })
      if (url.pathname === RECOMMEND_OUTCOME_PATH) return handleRecommendOutcome(request, env, ISOLATION_HEADERS)
      const validation = request.headers.has("cookie") ? await validateSession(request, env) : undefined
      return handleRecommend(request, env, validation?.status === "valid" ? validation.identity.login : undefined, ISOLATION_HEADERS)
    }
    if (url.pathname === APP_BOOTSTRAP_PATH) {
      if (request.method !== "GET") return json(405, { status: "error", message: "Method not allowed." })
      const identity = (env.IDENTITY_UPSTREAM_URL?.trim() ?? "") !== ""
      const cloud = (env.SMITHERS_CLOUD_API_BASE_URL?.trim() ?? "") !== ""
      const agent = Boolean(env.SMITHERS_CHAT_AUTH_TOKEN?.trim() || env.CHAT_PRODUCT_SERVICE_TOKEN?.trim())
      return json(200, {
        apiVersion: APP_API_VERSION,
        host: "cloud",
        version: "1.0.0",
        buildSha: env.SMITHERS_BUILD_SHA?.trim() || "unknown",
        // The shared table the Bun host and the parity matrix read. `terminal`
        // is the W4 relay: it stays false until that lane lands, so the Worker
        // never claims a door it has not opened.
        capabilities: cloudCapabilities({ identity, cloud, agent, checkout: checkoutEnabled(env), terminal: false, browser: env.BROWSER_EGRESS !== undefined }),
        authFlow: identity ? "redirect" : "none",
        sandbox: null
      })
    }
    if (url.pathname === CANCEL_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      const refusal = await requireTurnSession(request, env)
      // A signed-out caller may kill its own anonymous turn: the registry
      // refuses an owned registration to anyone but its owner, and cancelling
      // spends nothing.
      if (refusal instanceof Response && refusal.status !== 401) return refusal
      return handleCancel(request, env, refusal instanceof Response ? undefined : refusal)
    }
    // The two routes that spend a model credential. Both gate on the
    // session first and then on the login's turn ceiling, so a refusal
    // costs one Durable Object read and never reaches an upstream. The
    // cancel route above is deliberately unlimited: killing a turn must
    // always work, and it spends nothing.
    if (url.pathname === TURN_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      const gate = await requireTurnSession(request, env)
      if (gate instanceof Response) {
        return gate.status === 401 ? anonymousCatalogTurn(request, env, gate, ctx) : gate
      }
      if (gate !== undefined) {
        const budget = await spendTurn(env.TURN_LIMITS, gate.login)
        if (!budget.allowed) return turnLimitResponse(budget, ISOLATION_HEADERS)
      }
      return handleTurn(request, env, gate, undefined, ctx)
    }
    if (url.pathname === MODEL_STREAM_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      const gate = await requireTurnSession(request, env)
      if (gate instanceof Response) return gate
      if (gate !== undefined) {
        const budget = await spendTurn(env.TURN_LIMITS, gate.login)
        if (!budget.allowed) return turnLimitResponse(budget, ISOLATION_HEADERS)
      }
      return handleModelStream(request, env, gate)
    }
    if (url.pathname === WORKFLOW_PROVISION_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      return handleWorkflowProvision(request, env)
    }
    if (url.pathname === WORKFLOW_RPC_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      return handleWorkflowRpc(request, env)
    }
    if (url.pathname === WORKFLOW_TRIGGERS_PATH) {
      if (request.method !== "GET") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      return handleWorkflowTriggers(request, env, url)
    }
    if (url.pathname === TOOLS_BROWSER_FETCH_PATH) {
      if (request.method !== "POST") {
        return json(405, { status: "error", message: "Method not allowed." })
      }
      const refusal = await requireTurnSession(request, env)
      if (refusal instanceof Response) return refusal
      return handleBrowserFetch(request, env)
    }
    if (
      (url.pathname === AUTH_SIGN_IN_PATH || url.pathname === AUTH_CALLBACK_PATH) &&
      request.method === "GET"
    ) {
      return handleAuthNavigation(request, env, url.pathname === AUTH_SIGN_IN_PATH ? "start" : "callback")
    }
    if (url.pathname === AUTH_SESSION_PATH && request.method === "GET") {
      return probeAuthSession(request, env)
    }
    if (url.pathname.startsWith(AUTH_ROUTE_PREFIX) || url.pathname.startsWith(IDENTITY_ROUTE_PREFIX)) {
      return proxyToIdentity(request, env)
    }
    if (url.pathname === CLIENT_ERRORS_PATH && request.method === "POST") {
      return handleClientError(request, env)
    }
    if (url.pathname.startsWith(CLOUD_ROUTE_PREFIX)) {
      return handleCloudProxy(request, env, url)
    }
    if (platformProxyMatch(url.pathname, request.method)) {
      return handlePlatformProxy(request, env, url)
    }
    if (url.pathname.startsWith(BILLING_ROUTE_PREFIX)) {
      return proxyToBilling(request, env)
    }
    if (url.pathname.startsWith(ADMIN_ROUTE_PREFIX)) {
      return handleAdmin(request, env, url)
    }
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
      return withCanaryRobots(url, await env.ASSETS.fetch(new Request(new URL(repoPage.document, url).toString(), request)))
    }
    if (repoPage !== undefined) {
      return withCanaryRobots(url, await serveAppDocument(request, env, url, repoPage.document))
    }
    // A reload or a deep link inside the app: the frame path names no file in
    // the build, so the Worker serves the app document for it.
    if (isFramePath(url.pathname)) {
      return withCanaryRobots(url, await serveAppDocument(request, env, url, DEFAULT_APP_DOCUMENT_PATH))
    }
    // Everything else is the site build as the assets layer serves it: the
    // landing page, the docs, the hashed chunks, and its 404 page.
    return withCanaryRobots(url, await env.ASSETS.fetch(request))
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx?: TurnExecutionContext): Promise<Response> {
    try {
      // Await the router: its routes may return promises without awaiting them.
      return await worker.fetch(request, env, ctx)
    } catch (error) {
      console.error("worker fetch failed:", error)
      return json(500, {
        status: "error",
        message: "Smithers could not complete this request. Try again in a moment."
      })
    }
  }
}
