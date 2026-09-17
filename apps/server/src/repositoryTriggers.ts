/*
 * The generic flow triggers of one repository, as the browser reaches them:
 * the three `/api/workflow/trigger-*` routes of L36 §1.5 (E9, E10, E11).
 *
 * A generic trigger is a repository job whose key is `flow:<slug>` — a
 * namespace disjoint from the five built-in jobs, which carry no colon. The
 * registration itself is written by the workspace host through the gateway
 * bearer (E1); a browser can never hold that credential, so these routes are
 * the read, the stop, and the approval receipt, each under the workflow
 * session gate and each spending the caller's own Cloud token.
 *
 * The listing parses EACH ROW ON ITS OWN and drops what it does not
 * recognise. A foreign registration — one of the five built-ins, a row a
 * later Plue writes, a row past this Worker's vocabulary — never fails the
 * listing, and the five setup jobs' own recovery (repositorySetupRecovery.ts)
 * is a separate reader that this file never touches.
 */
import { Data, Effect, Result } from "effect"
import { z } from "zod"
import { ServerConfig } from "./Config"
import { fetchCloudToken, isRelayRepoName } from "./gateway"
import type { UpstreamFailure } from "./Failures"
import { discardBody, fetchWithDeadline, readBoundedJson } from "./Http"
import type { Transport } from "./Http"
import { json, readBody, refuse, refuseWithStatus, upstreamUnreachable } from "./Responses"
import { requireWorkflowSession } from "./workflows"

/** The Worker routes this file serves, beside the existing `/api/workflow/*` block. */
export const TRIGGER_REGISTRATIONS_PATH = "/api/workflow/trigger-registrations"
export const TRIGGER_PAUSE_PATH = "/api/workflow/trigger-pause"
export const TRIGGER_APPROVAL_PATH = "/api/workflow/trigger-approval"

/** The job key of a generic flow trigger (L36 §1.1). The five built-ins contain no colon. */
export const FLOW_JOB_KEY = /^flow:[a-z0-9][a-z0-9-]{0,63}$/
/** The slug alone, as the app names a schedule. */
export const FLOW_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The `flow:<slug>` key of a slug, for the routes that address one registration. */
export const flowJobKey = (slug: string): string => `flow:${slug}`

type TriggerServices = Transport | ServerConfig

class TriggerError extends Data.TaggedError("TriggerError")<{ readonly status: number; readonly message: string }> {}

/** Either Smithers Cloud refused with a status, or nothing answered at all. */
type TriggerFailure = TriggerError | UpstreamFailure

/** One `flow:*` registration as this route publishes it. Every field is Plue's own. */
export interface TriggerRegistrationRow {
  readonly slug: string
  readonly flowId: string
  readonly schedule: string
  readonly enabled: boolean
  readonly revision: number
  readonly digest: string
  readonly sourceRevision: string
  readonly nextFireAt: string | null
  readonly registrationId: string
}

const RegistrationRow = z.object({
  id: z.string().min(1),
  job: z.string().regex(FLOW_JOB_KEY),
  flow_id: z.string().min(1),
  schedule: z.string().min(1).max(200),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  source_revision: z.string().min(1),
  next_fire_at: z.iso.datetime({ offset: true }).nullish()
})

/** A row this Worker recognises as a generic trigger, or nothing at all. */
export const triggerRegistrationRow = (candidate: unknown): TriggerRegistrationRow | undefined => {
  const parsed = RegistrationRow.safeParse(candidate)
  if (!parsed.success) return undefined
  const row = parsed.data
  return {
    slug: row.job.slice("flow:".length),
    flowId: row.flow_id,
    schedule: row.schedule,
    enabled: row.enabled,
    revision: row.revision,
    digest: row.digest,
    sourceRevision: row.source_revision,
    nextFireAt: row.next_fire_at ?? null,
    registrationId: row.id
  }
}

/** One authenticated Cloud call on the caller's behalf, re-minting the token once on a 401. */
const cloud = (
  login: string,
  path: string,
  init: { readonly method: "GET" | "POST"; readonly body?: string },
  limit: number
): Effect.Effect<unknown, TriggerFailure, TriggerServices> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const call = (value: string) =>
      fetchWithDeadline("The repository trigger", new URL(path, config.cloudApiBaseUrl), {
        method: init.method,
        headers: {
          authorization: `Bearer ${value}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(init.body === undefined ? {} : { body: init.body })
      }, config.upstreamTimeoutMs)
    let token = yield* fetchCloudToken(login)
    if (token.status !== "ok") return yield* Effect.fail(new TriggerError({ status: 503, message: token.detail }))
    let response = yield* call(token.token)
    if (response.status === 401) {
      yield* discardBody(response)
      token = yield* fetchCloudToken(login)
      if (token.status !== "ok") return yield* Effect.fail(new TriggerError({ status: 503, message: token.detail }))
      response = yield* call(token.token)
    }
    const body = yield* readBoundedJson(response, limit).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (response.ok) return body
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {}
    const message = typeof record.message === "string" && record.message !== ""
      ? record.message
      : `Smithers Cloud answered HTTP ${response.status}.`
    return yield* Effect.fail(new TriggerError({ status: response.status, message }))
  })

/**
 * The refusal a failure earns, honest about which side it came from: Smithers
 * Cloud's own status where the status is the evidence, this deployment's
 * missing Cloud identity, or a transport that never produced a response.
 */
const cloudRefusal = (failure: TriggerFailure): Response =>
  failure._tag !== "TriggerError"
    ? upstreamUnreachable("Smithers Cloud", failure)
    : failure.status === 409
    ? refuseWithStatus(409, "request_conflict", failure.message)
    : failure.status === 503
    ? refuse("cloud_token_unavailable", failure.message)
    : refuse("upstream_refused", failure.message)

const repoOf = (value: unknown): string | undefined =>
  typeof value === "string" && isRelayRepoName(value) ? value : undefined

const slugOf = (value: unknown): string | undefined =>
  typeof value === "string" && FLOW_SLUG.test(value) ? value : undefined

const digestOf = (value: unknown): string | undefined =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined

/**
 * E9 — every `flow:*` registration of one repository.
 *
 * Row by row, dropping what it does not recognise: a listing that carries the
 * five built-ins, an eleventh row of any kind, or a shape a later Plue adds
 * still answers with the triggers it could read.
 */
export const handleTriggerRegistrations = (
  request: Request,
  url: URL
): Effect.Effect<Response, never, TriggerServices> =>
  Effect.gen(function* () {
    const repo = repoOf(url.searchParams.get("repo") ?? undefined)
    if (repo === undefined) return refuse("request_invalid", "Query must name the repository as ?repo=owner/repo.")
    const session = yield* requireWorkflowSession(request)
    if (session instanceof Response) return session
    const read = yield* Effect.result(cloud(session.login, `/api/repos/${repo}/repository-jobs`, { method: "GET" }, 1_500_000))
    if (Result.isFailure(read)) return cloudRefusal(read.failure)
    const rows = Array.isArray(read.success) ? read.success : []
    return json(200, {
      status: "ok",
      repo,
      rows: rows.map(triggerRegistrationRow).filter((row): row is TriggerRegistrationRow => row !== undefined)
    })
  })

/** E10 — stop a schedule the caller enabled. */
export const handleTriggerPause = (request: Request): Effect.Effect<Response, never, TriggerServices> =>
  Effect.gen(function* () {
    const session = yield* requireWorkflowSession(request)
    if (session instanceof Response) return session
    const body = yield* readBody(request)
    if (body instanceof Response) return body
    const candidate = typeof body === "object" && body !== null ? body as Record<string, unknown> : {}
    const repo = repoOf(candidate.repo)
    const slug = slugOf(candidate.slug)
    if (repo === undefined || slug === undefined) return refuse("request_invalid", "Body must be { repo, slug }.")
    const paused = yield* Effect.result(
      cloud(session.login, `/api/repos/${repo}/repository-jobs/${flowJobKey(slug)}/pause`, { method: "POST" }, 16_000)
    )
    if (Result.isFailure(paused)) return cloudRefusal(paused.failure)
    const record = typeof paused.success === "object" && paused.success !== null ? paused.success as Record<string, unknown> : {}
    return json(200, { status: "ok", paused: typeof record.paused === "number" ? record.paused : 1 })
  })

/**
 * E11 — the approval receipt.
 *
 * Plue stamps who approved and when from the authenticated session; nothing
 * on this wire can name either. The app supplies only what Control produced:
 * the plan's id, its digest, and the envelope that plan was made under.
 */
export const handleTriggerApproval = (request: Request): Effect.Effect<Response, never, TriggerServices> =>
  Effect.gen(function* () {
    const session = yield* requireWorkflowSession(request)
    if (session instanceof Response) return session
    const body = yield* readBody(request)
    if (body instanceof Response) return body
    const candidate = typeof body === "object" && body !== null ? body as Record<string, unknown> : {}
    const repo = repoOf(candidate.repo)
    const slug = slugOf(candidate.slug)
    const planId = typeof candidate.planId === "string" && candidate.planId !== "" ? candidate.planId : undefined
    const planDigest = digestOf(candidate.planDigest)
    if (repo === undefined || slug === undefined || planId === undefined || planDigest === undefined) {
      return refuse("request_invalid", "Body must be { repo, slug, planId, planDigest, envelope }.")
    }
    const recorded = yield* Effect.result(cloud(
      session.login,
      `/api/repos/${repo}/repository-jobs/${flowJobKey(slug)}/approvals`,
      {
        method: "POST",
        body: JSON.stringify({ plan_id: planId, plan_digest: planDigest, envelope: candidate.envelope ?? null })
      },
      16_000
    ))
    if (Result.isFailure(recorded)) return cloudRefusal(recorded.failure)
    const record = typeof recorded.success === "object" && recorded.success !== null
      ? recorded.success as Record<string, unknown>
      : {}
    if (typeof record.approved_at !== "string" || typeof record.approved_by !== "number") {
      return refuse("upstream_malformed", "Smithers Cloud did not state who approved this plan.")
    }
    return json(200, { status: "ok", approvedAt: record.approved_at, approvedBy: record.approved_by })
  })
