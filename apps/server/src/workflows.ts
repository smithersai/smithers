import * as Effect from "effect/Effect"
import { ServerConfig } from "./Config"
import { callGateway, ensureGatewayReady, isGatewayWorkspaceId, isRelayRepoName } from "./gateway"
import type { GatewayCallOutcome, GatewaySessions } from "./gateway"
import {
  decodeGatewayResponse,
  encodeGatewayRequest,
  GATEWAY_PROCEDURE_MOUNTS,
  NON_REPLAYABLE_GATEWAY_PROCEDURES
} from "./gatewayRpc"
import { discardBody, readText } from "./Http"
import type { Transport } from "./Http"
import { validateSession } from "./identity"
import type { ValidatedIdentity } from "./identity"
import { json, notConfigured, readBody, refuse } from "./Responses"
import { LIST_TRIGGERS_PAYLOAD, noLiveTriggers, workflowTriggersFromFrame } from "./workflowTriggers"

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

type WorkflowServices = Transport | ServerConfig | GatewaySessions

/**
 * The workflow seam spends the user's own workspace resources, so on any
 * deployment that HAS an identity seam it requires a validated, allowlisted
 * session — the same gate as a turn. Returns the validated identity or the
 * refusal response.
 */
export const requireWorkflowSession = (request: Request): Effect.Effect<ValidatedIdentity | Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.identityUpstreamUrl === undefined) {
      return notConfigured(
        "The workflow seam",
        "IDENTITY_UPSTREAM_URL is unset. The per-user gateway needs a validated session, and no identity service can provide one"
      )
    }
    const validation = yield* validateSession(request)
    if (validation.status === "unavailable") return validation.response
    if (validation.status === "invalid") {
      return refuse("sign_in_required", "Sign in to run workflows on your workspace.")
    }
    const session = validation.identity
    if (!session.allowlisted) {
      return refuse("account_not_allowlisted", "This account is not in the closed-alpha allowlist yet.")
    }
    return session
  })

/*
 * The sentence for a status neither union has. A gradual deployment can leave
 * this script reading a gateway-sessions object already running the next one,
 * and `isProvisionOutcome` (gateway.ts) passes any object with a string status
 * through, so the exhaustive `default:` is dead to the compiler and alive on
 * the wire. Its own detail is the honest sentence when it sent one.
 */
const UNKNOWN_STATUS_DETAIL = "The workspace gateway answered a state this deployment does not know."

const unknownStatusDetail = (outcome: unknown): string => {
  const detail = typeof outcome === "object" && outcome !== null ? (outcome as { detail?: unknown }).detail : undefined
  return typeof detail === "string" && detail !== "" ? detail : UNKNOWN_STATUS_DETAIL
}

/** The typed, non-gateway answers a gateway call can produce, in one place. */
const gatewayCallResponse = (call: Exclude<GatewayCallOutcome, { readonly status: "ok" }>): Response => {
  switch (call.status) {
    case "plan_limit_exceeded":
      return json(402, { ...call.refusal, code: "plan_limit_exceeded", fault: "user", message: call.detail })
    case "provisioning":
      return json(200, { status: "provisioning", message: call.detail })
    case "no_capacity":
      return json(200, { status: "no-capacity", message: call.detail })
    // The user's own box cap, not the fleet's: a separate wire state so the
    // product never tells someone at their limit that the infrastructure failed.
    case "quota_exceeded":
      return json(200, { status: "quota-exceeded", message: call.detail })
    case "no_cloud_token":
      return json(200, { status: "no-cloud-identity", message: call.detail })
    case "no_cloud_repo":
      return json(200, { status: "no-cloud-repo", message: call.detail })
    // The pinned workspace is gone, which is its own registered code (409,
    // infra). Under `upstream_refused` the person reads "retry creates a new
    // one" beneath a 502 dependency headline.
    case "workspace_gone":
      return refuse("workspace_gone", call.detail)
    // Its own code, because its own thing happened: the box is coming up.
    // Under `upstream_refused` a person waiting on a resume reads "Something
    // Smithers depends on refused that", and nothing refused anything.
    case "workspace_starting":
      return refuse("workspace_starting", call.detail)
    case "unknown_outcome":
    case "unavailable":
      return refuse("upstream_refused", call.detail)
    default: {
      const exhaustive: never = call
      return refuse("upstream_refused", unknownStatusDetail(exhaustive))
    }
  }
}

/*
 * owner/repo — the shape the Cloud provision route takes; anything else (a dot
 * segment that URL parsing would resolve away included) is refused pre-upstream
 * by `isRelayRepoName`.
 */
const parseWorkflowRepo = (value: unknown): string | undefined =>
  typeof value === "string" && isRelayRepoName(value) ? value : undefined

export const handleWorkflowProvision = (request: Request): Effect.Effect<Response, never, WorkflowServices> =>
  Effect.gen(function* () {
    const session = yield* requireWorkflowSession(request)
    if (session instanceof Response) return session
    const body = yield* readBody(request)
    if (body instanceof Response) return body
    const repo = typeof body === "object" && body !== null && "repo" in body
      ? parseWorkflowRepo((body as { repo?: unknown }).repo)
      : undefined
    if (repo === undefined) {
      return refuse("request_invalid", "Body must be { repo } as owner/repo.")
    }
    const workspaceId = (body as { workspaceId?: unknown }).workspaceId
    if (workspaceId !== undefined && !isGatewayWorkspaceId(workspaceId)) {
      return refuse("request_invalid", "workspaceId must be a canonical workspace UUID.")
    }
    const outcome = yield* ensureGatewayReady(session.login, repo, workspaceId)
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
      case "plan_limit_exceeded":
        return json(402, { ...outcome.refusal, code: "plan_limit_exceeded", fault: "user", message: outcome.detail })
      case "provisioning":
        return json(200, { status: "provisioning", message: outcome.detail })
      /*
       * On the wire this is `provisioning`, which is the state the caller
       * already polls to its own 180s deadline (apps/app controller/workflows
       * `provisionWorkspaceImpl`). A code of its own here would reach that
       * loop as an unrecognised body and end the wait as a failure, which is
       * the opposite of what a starting workspace needs. The typed state pays
       * off on the rpc route, where nobody is polling.
       */
      case "workspace_starting":
        return json(200, { status: "provisioning", message: outcome.detail })
      case "no_capacity":
        return json(200, { status: "no-capacity", message: outcome.detail })
      case "quota_exceeded":
        // Distinct from no-capacity on purpose: this account is at its own
        // workspace limit, which is a fact about the user, not the fleet.
        return json(200, { status: "quota-exceeded", message: outcome.detail })
      case "no_cloud_token":
        return json(200, { status: "no-cloud-identity", message: outcome.detail })
      case "no_cloud_repo":
        // §4: a watched repo with no Cloud counterpart — a state of its own.
        return json(200, { status: "no-cloud-repo", message: outcome.detail })
      case "workspace_gone":
        // The repository is on Cloud and the pinned box is not: an unbound
        // caller asks again and gets a new one, which is what 409 infra says.
        return refuse("workspace_gone", outcome.detail)
      case "unavailable":
        return refuse("upstream_refused", outcome.detail)
      default: {
        const exhaustive: never = outcome
        return refuse("upstream_refused", unknownStatusDetail(exhaustive))
      }
    }
  })

/**
 * Relay one call to the caller's own workspace gateway.
 *
 * The body names the repo (which per-user gateway to reach), the procedure
 * (what is being called), and its payload. The Worker refuses a procedure the
 * product does not relay before spending anything, writes the gateway's RPC
 * frame for it, adds the bearer credential a browser can never hold, and
 * answers the gateway's own outcome unwrapped.
 */
export const handleWorkflowRpc = (request: Request): Effect.Effect<Response, never, WorkflowServices> =>
  Effect.gen(function* () {
    const session = yield* requireWorkflowSession(request)
    if (session instanceof Response) return session
    const body = yield* readBody(request)
    if (body instanceof Response) return body
    const candidate = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined
    const repo = parseWorkflowRepo(candidate?.repo)
    const procedure = typeof candidate?.procedure === "string" ? candidate.procedure : ""
    if (repo === undefined || procedure === "") {
      return refuse("request_invalid", "Body must be { repo, procedure, payload? }.")
    }
    const workspaceId = candidate?.workspaceId
    if (workspaceId !== undefined && !isGatewayWorkspaceId(workspaceId)) {
      return refuse("request_invalid", "workspaceId must be a canonical workspace UUID.")
    }
    const mount = GATEWAY_PROCEDURE_MOUNTS[procedure]
    if (mount === undefined) {
      return refuse("procedure_not_relayed", `The workflow seam does not relay ${procedure}.`)
    }
    const call = yield* callGateway(session.login, repo, mount, {
      method: "POST",
      ...(workspaceId === undefined ? {} : { workspaceId }),
      text: encodeGatewayRequest(procedure, candidate?.payload),
      replayable: !NON_REPLAYABLE_GATEWAY_PROCEDURES.includes(procedure)
    })
    if (call.status !== "ok") return gatewayCallResponse(call)
    const text = yield* readText(call.response).pipe(Effect.catch(() => Effect.succeed("")))
    // A gateway that answered at the HTTP level but not with a frame is still a
    // refusal the client can render, never a 500 from this Worker.
    const frame = call.response.status === 200
      ? decodeGatewayResponse(text)
      : { ok: false as const, error: { message: `The workspace answered HTTP ${call.response.status}.` } }
    return json(200, frame)
  })

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
export const handleWorkflowTriggers = (request: Request, url: URL): Effect.Effect<Response, never, WorkflowServices> =>
  Effect.gen(function* () {
    const repo = parseWorkflowRepo(url.searchParams.get("repo") ?? undefined)
    if (repo === undefined) {
      return refuse("request_invalid", "Query must name the repository as ?repo=owner/repo.")
    }
    const session = yield* requireWorkflowSession(request)
    if (session instanceof Response) return json(200, noLiveTriggers(repo))
    const call = yield* callGateway(session.login, repo, GATEWAY_PROCEDURE_MOUNTS.List ?? "/rpc", {
      method: "POST",
      text: encodeGatewayRequest("List", LIST_TRIGGERS_PAYLOAD),
      provision: false
    })
    if (call.status !== "ok" || call.response.status !== 200) {
      if (call.status === "ok") yield* discardBody(call.response)
      return json(200, noLiveTriggers(repo))
    }
    const text = yield* readText(call.response).pipe(Effect.catch(() => Effect.succeed("")))
    return json(200, workflowTriggersFromFrame(repo, decodeGatewayResponse(text)))
  })
