import { isGatewayWorkspaceId } from "@smthrs/rpc/GatewayWorkspace"
import { upstreamDeadline } from "./upstreamDeadline"
export { isGatewayWorkspaceId } from "@smthrs/rpc/GatewayWorkspace"

const { run: withDeadline, timeoutMs: upstreamTimeoutMs, TimeoutError: UpstreamTimeoutError } = upstreamDeadline

/*
 * Wave 11 — the per-user gateway seam. The product Worker provisions (or
 * resumes) the signed-in user's workspace gateway on Smithers Cloud and
 * relays RPC/event calls to it, implementing the WAVE4-RELAY-RECEIPT §5
 * contract faithfully:
 *
 *   - provision-or-resume is idempotent: POST /api/repos/{owner}/{repo}/gateway
 *     is re-called freely; a warm resume returns the same gateway with a fresh
 *     expires_at,
 *   - re-call before expires_at (half-life cadence) and ALWAYS adopt the
 *     returned gateway_id/token/base_url — a reprovision legitimately hands
 *     back different values,
 *   - the error taxonomy is distinct: 401 (re-provision once), 409 (still
 *     provisioning — the caller polls, never stampedes), 500 no_capacity
 *     (surfaced honestly, never retry-looped).
 *
 * Gateway tokens live server-side ONLY: per-user records are held in the
 * GatewaySessionRegistry Durable Object (keyed by login) and never reach a
 * browser response body. The browser talks to /api/workflow/*; the Worker
 * holds the token and sets the Authorization header the relay requires.
 */

export interface GatewayRecord {
  readonly gatewayId: string
  readonly baseUrl: string
  readonly token: string
  readonly vmId: string | null
  readonly workspaceId?: string
  readonly expiresAt: number
  /** Half-life cadence (§5): re-resolve at the midpoint of the issued window. */
  readonly renewAfter: number
  /** When this record was minted — the floor under a forced re-provision. */
  readonly provisionedAt: number
}

interface GatewayRecordRow {
  readonly gatewayId: string
  readonly baseUrl: string
  readonly token: string
  readonly vmId: string | null
  readonly workspaceId?: string
  readonly expiresAt: number
  readonly renewAfter: number
  readonly provisionedAt?: number
}

export interface GatewaySessionStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (key: string, value: unknown) => Promise<void>
}

export interface GatewaySessionStub {
  readonly fetch: (request: Request) => Promise<Response>
}

export interface GatewaySessionNamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => GatewaySessionStub
}

/**
 * Per-user gateway records, one Durable Object per login, keyed inside by
 * repo. The record carries the relay token, so it must never leave the
 * server: the read route is consumed by this Worker's own handlers only.
 *
 * The registry is also where a resolution is COORDINATED. workerd runs one
 * instance per login, so its in-memory in-progress set is the join point:
 * concurrent cold or expired misses for one login/repo share a single
 * token-door + provision sequence instead of each running their own, and
 * every joiner reads back the record the leader persisted.
 */
export class GatewaySessionRegistry {
  /** In-flight resolutions, keyed exactly like the record they mint. */
  private readonly inProgress = new Map<string, Promise<ProvisionOutcome>>()

  constructor(
    private readonly ctx: { readonly storage: GatewaySessionStorage },
    private readonly env: GatewayRegistryEnv
  ) {}

  private key(repo: string, workspaceId?: string): string {
    return `gateway:${workspaceRecordKey(repo, workspaceId)}`
  }

  private async readStored(repo: string, workspaceId: string | undefined): Promise<GatewayRecord | undefined> {
    try {
      const row = await this.ctx.storage.get<GatewayRecordRow>(this.key(repo, workspaceId))
      if (row === undefined || row === null) return undefined
      // A record written before this field existed is old by definition, so
      // it has already earned the right to be re-provisioned on a tunnel
      // failure.
      return { ...row, provisionedAt: typeof row.provisionedAt === "number" ? row.provisionedAt : 0 }
    } catch {
      // A store that cannot answer a read is cold, exactly as the Worker's
      // own read path treats it.
      return undefined
    }
  }

  /**
   * The §5 provision-or-resume cadence, coordinated per login/repo: a cached
   * record inside its half-life answers directly; anything else joins the
   * in-flight resolution if one exists, and only the first caller provisions.
   */
  private async resolve(
    login: string,
    repo: string,
    workspaceId: string | undefined,
    force: boolean
  ): Promise<ProvisionOutcome> {
    if (!force) {
      const cached = await this.readStored(repo, workspaceId)
      if (cached !== undefined && Date.now() < cached.renewAfter) return { status: "ready", record: cached }
    }
    const pending = this.inProgress.get(this.key(repo, workspaceId))
    if (pending !== undefined) {
      const outcome = await pending
      if (outcome.status !== "ready") return outcome
      // Recheck what the leader persisted rather than trusting the join:
      // the stored record is the hand-off a recreated instance would serve.
      const persisted = await this.readStored(repo, workspaceId)
      return persisted === undefined ? outcome : { status: "ready", record: persisted }
    }
    const task = this.provision(login, repo, workspaceId)
    this.inProgress.set(this.key(repo, workspaceId), task)
    try {
      return await task
    } finally {
      // Cleared only after the record write inside the task has settled, so
      // a later caller either joins this task or reads the fresh record.
      this.inProgress.delete(this.key(repo, workspaceId))
    }
  }

  /**
   * The leader's half of a resolution: the Cloud token door, the provision
   * POST, exactly one re-mint on a 401, then persistence. A record that
   * cannot be stored is not reported ready.
   */
  private async provision(login: string, repo: string, workspaceId: string | undefined): Promise<ProvisionOutcome> {
    const cloudToken = await fetchCloudToken(this.env, login)
    if (cloudToken.status !== "ok") {
      return cloudToken.status === "not_found"
        ? { status: "no_cloud_token", detail: cloudToken.detail }
        : { status: "unavailable", detail: cloudToken.detail }
    }
    let outcome = await provisionGateway(this.env, repo, cloudToken.token, workspaceId)
    if (outcome.status === "cloud_token_rejected") {
      // The vaulted Cloud token was rejected (plue-side expiry/revocation):
      // the door re-exchanges from the vaulted GitHub token, so one fresh
      // mint may legitimately succeed. More than one retry would be a loop.
      const reminted = await fetchCloudToken(this.env, login)
      if (reminted.status !== "ok") {
        return reminted.status === "not_found"
          ? { status: "no_cloud_token", detail: reminted.detail }
          : { status: "unavailable", detail: reminted.detail }
      }
      const retried = await provisionGateway(this.env, repo, reminted.token, workspaceId)
      outcome = retried.status === "cloud_token_rejected"
        ? { status: "unavailable", detail: "Smithers Cloud rejected a freshly minted identity token." }
        : retried
    }
    if (outcome.status !== "ready") return outcome
    try {
      await this.ctx.storage.put(this.key(repo, workspaceId), outcome.record)
    } catch (error) {
      return {
        status: "unavailable",
        detail: `The gateway session store is unavailable: ${error instanceof Error ? error.message : "unknown error"}`
      }
    }
    return outcome
  }

  async fetch(request: Request): Promise<Response> {
    const answer = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    const url = new URL(request.url)
    if (url.pathname === "/record" && request.method === "GET") {
      const repo = url.searchParams.get("repo") ?? ""
      const record = await this.ctx.storage.get<GatewayRecordRow>(this.key(repo, url.searchParams.get("workspace_id") ?? undefined))
      return answer({ record: record ?? null })
    }
    if (url.pathname === "/record" && request.method === "PUT") {
      const body = (await request.json().catch(() => undefined)) as
        | { repo?: unknown; workspaceId?: unknown; record?: unknown }
        | undefined
      if (
        typeof body?.repo !== "string" || body.repo === "" || typeof body.record !== "object" || body.record === null
      ) {
        return new Response("bad request", { status: 400 })
      }
      await this.ctx.storage.put(this.key(body.repo, typeof body.workspaceId === "string" ? body.workspaceId : undefined), body.record)
      return answer({ ok: true })
    }
    if (url.pathname === "/resolve" && request.method === "POST") {
      const body = (await request.json().catch(() => undefined)) as
        | { login?: unknown; repo?: unknown; workspaceId?: unknown; force?: unknown }
        | undefined
      if (typeof body?.login !== "string" || body.login === "" || typeof body.repo !== "string" || body.repo === "") {
        return new Response("bad request", { status: 400 })
      }
      const outcome = await this.resolve(
        body.login,
        body.repo,
        typeof body.workspaceId === "string" ? body.workspaceId : undefined,
        body.force === true
      )
      return answer(outcome)
    }
    return new Response("not found", { status: 404 })
  }
}

/**
 * owner/repo, and nothing that could rewrite the upstream path. `.` and `..`
 * match the character class a repository name allows, but URL parsing resolves
 * them away: `../admin` would aim the user's server-held Cloud token at a route
 * outside this seam, which is exactly what holding the token server-side is for.
 * Dot-PREFIXED names (`.github`) are real repositories and stay legal.
 */
export const isRelayRepoName = (value: string): boolean =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)

export interface GatewayEnv {
  readonly IDENTITY_UPSTREAM_URL?: string
  readonly IDENTITY_SERVICE_TOKEN?: string
  readonly SMITHERS_CLOUD_API_BASE_URL?: string
  /**
   * The per-login session registry. Bound on every real deployment
   * (wrangler.jsonc); tests drive the real class over in-memory storage.
   */
  readonly GATEWAY_SESSIONS: GatewaySessionNamespace
  /** Headers deadline in milliseconds; defaults to 20,000. */
  readonly UPSTREAM_TIMEOUT_MS?: string
}

/** The slice of the Worker env the registry itself needs to run a resolution. */
export type GatewayRegistryEnv = Omit<GatewayEnv, "GATEWAY_SESSIONS">

export const DEFAULT_CLOUD_API_BASE_URL = "https://api.jjhub.tech"

/*
 * A separator no login or repo can contain (NUL): `${login}${repo}` alone would
 * let ("ab", "c/d") and ("a", "bc/d") share one entry — a cross-account record.
 * Written as the `\u0000` ESCAPE, never as a literal byte: a raw NUL made
 * this whole file binary to git, grep and the editors, so its diffs were
 * unreadable and a review of the seam holding the user's Cloud token could not
 * be read.
 */
const workspaceRecordKey = (repo: string, workspaceId?: string): string =>
  workspaceId === undefined ? repo : `${repo}\u0000${workspaceId}`

const readRecord = async (env: GatewayEnv, login: string, repo: string, workspaceId?: string): Promise<GatewayRecord | undefined> => {
  try {
    const stub = env.GATEWAY_SESSIONS.get(env.GATEWAY_SESSIONS.idFromName(login))
    const response = await stub.fetch(
      new Request(`https://gateway-sessions.internal/record?repo=${encodeURIComponent(repo)}${workspaceId === undefined ? "" : `&workspace_id=${encodeURIComponent(workspaceId)}`}`)
    )
    const body = (await response.json().catch(() => undefined)) as { record?: GatewayRecordRow | null } | undefined
    const record = body?.record
    if (record === undefined || record === null || record.workspaceId !== workspaceId) return undefined
    // A record written before this field existed is old by definition, so it
    // has already earned the right to be re-provisioned on a tunnel failure.
    return { ...record, provisionedAt: typeof record.provisionedAt === "number" ? record.provisionedAt : 0 }
  } catch {
    return undefined
  }
}

const readBoundedResponseText = async (response: Response, limit = 240): Promise<string> => {
  const reader = response.body?.getReader()
  if (reader === undefined) return ""
  const decoder = new TextDecoder()
  let detail = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    detail += decoder.decode(value, { stream: true })
    if (detail.length >= limit) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  return detail.slice(0, limit).trim()
}

export type CloudTokenOutcome =
  | { readonly status: "ok"; readonly token: string }
  | { readonly status: "not_configured"; readonly detail: string }
  | { readonly status: "unavailable"; readonly detail: string }
  | { readonly status: "not_found"; readonly detail: string }

/**
 * The per-user Cloud token door (wave-11b): POST /api/identity/cloud-token on
 * the identity worker, service-token only, by login. The token mints lazily
 * upstream; a typed failure is surfaced, never fabricated.
 */
export const fetchCloudToken = async (env: GatewayRegistryEnv, login: string): Promise<CloudTokenOutcome> => {
  const upstream = env.IDENTITY_UPSTREAM_URL?.trim()
  if (upstream === undefined || upstream === "") {
    return { status: "not_configured", detail: "IDENTITY_UPSTREAM_URL is unset on this deployment." }
  }
  const serviceToken = env.IDENTITY_SERVICE_TOKEN?.trim()
  if (serviceToken === undefined || serviceToken === "") {
    return { status: "not_configured", detail: "IDENTITY_SERVICE_TOKEN is unset on this deployment." }
  }
  let response: Response
  try {
    response = await withDeadline(
      "The Cloud token door",
      (signal) => fetch(new URL("/api/identity/cloud-token", upstream).toString(), {
        signal,
        method: "POST",
        headers: { "content-type": "application/json", "x-smithers-service-token": serviceToken },
        body: JSON.stringify({ login })
      }),
      upstreamTimeoutMs(env)
    )
  } catch (error) {
    return {
      status: "unavailable",
      detail: `The identity service is unreachable: ${error instanceof Error ? error.message : "unknown error"}`
    }
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 200)
    return {
      status: "unavailable",
      detail: `The Cloud token door answered HTTP ${response.status}${detail === "" ? "." : `: ${detail}`}`
    }
  }
  const body = (await response.json().catch(() => undefined)) as
    | { found?: unknown; token?: unknown; cloud?: { status?: unknown; reason?: unknown } }
    | undefined
  if (body?.found === true && typeof body.token === "string" && body.token !== "") {
    return { status: "ok", token: body.token }
  }
  const cloudStatus = typeof body?.cloud?.status === "string" ? body.cloud.status : "unknown"
  const cloudReason = typeof body?.cloud?.reason === "string" ? body.cloud.reason : null
  return {
    status: "not_found",
    detail: `No Smithers Cloud identity is available for this account (${cloudStatus}${
      cloudReason === null ? "" : `: ${cloudReason}`
    }).`
  }
}

export type ProvisionOutcome =
  | { readonly status: "ready"; readonly record: GatewayRecord }
  | { readonly status: "provisioning"; readonly detail: string }
  | { readonly status: "no_capacity"; readonly detail: string }
  | { readonly status: "unavailable"; readonly detail: string }
  | { readonly status: "no_cloud_token"; readonly detail: string }
  /*
   * Wave 12 §4: the watched set is a GITHUB set, but a gateway needs a
   * Smithers Cloud repository. When the two don't coincide Cloud answers 404,
   * and that is a distinct, honest, un-retryable state — not the generic
   * "provisioning answered HTTP 404" the raw seam used to leak.
   */
  | { readonly status: "no_cloud_repo"; readonly detail: string }

const readProvisionError = async (response: Response): Promise<string> =>
  readBoundedResponseText(response).catch(() => "")

/**
 * Provision-or-resume (§5): POST {cloud}/api/repos/{owner}/{repo}/gateway with
 * the user's Cloud token. Idempotent; on success ALWAYS adopt the returned
 * gateway_id/token/base_url. The taxonomy: 401 = the Cloud token was rejected
 * (the caller may re-mint and retry once), 409 = mid-provision (poll, don't
 * stampede), 500 no_capacity = pool exhausted (surface honestly, never
 * retry-loop).
 */
const provisionGateway = async (
  env: GatewayRegistryEnv,
  repo: string,
  cloudToken: string,
  workspaceId?: string
): Promise<ProvisionOutcome | { readonly status: "cloud_token_rejected" }> => {
  const base = env.SMITHERS_CLOUD_API_BASE_URL?.trim() || DEFAULT_CLOUD_API_BASE_URL
  let response: Response
  try {
    response = await withDeadline(
      "Smithers Cloud",
      (signal) => fetch(new URL(`/api/repos/${repo}/gateway`, base).toString(), {
        signal,
        method: "POST",
        headers: {
          authorization: `Bearer ${cloudToken}`,
          ...(workspaceId === undefined ? {} : { "content-type": "application/json" })
        },
        ...(workspaceId === undefined ? {} : { body: JSON.stringify({ workspace_id: workspaceId }) })
      }),
      upstreamTimeoutMs(env)
    )
  } catch (error) {
    /*
     * A provision POST that never answers is not a dead end: the route is
     * idempotent, and Cloud may well still be building the sandbox behind
     * the silence. So a deadline lands in the seam's `provisioning` state —
     * the caller polls to its own bounded deadline and then says so — and
     * only a real connection failure is reported as unreachable. Either way
     * the request ANSWERS, which is the whole point.
     */
    if (error instanceof UpstreamTimeoutError) {
      return {
        status: "provisioning",
        detail: `Smithers Cloud hasn't finished preparing the workspace for ${repo} yet — it took longer than ${
          error.timeoutMs
        }ms to answer.`
      }
    }
    return {
      status: "unavailable",
      detail: `Smithers Cloud is unreachable: ${error instanceof Error ? error.message : "unknown error"}`
    }
  }
  if (response.status === 401) {
    await response.body?.cancel()
    return { status: "cloud_token_rejected" }
  }
  if (response.status === 409) {
    const refusal = await response.json().catch(() => undefined) as { code?: unknown; message?: unknown } | undefined
    return {
      status: refusal?.code === "coding_host_unavailable" ? "unavailable" : "provisioning",
      detail: typeof refusal?.message === "string" ? refusal.message : `The workspace for ${repo} is still being prepared.`
    }
  }
  if (response.status === 404) {
    await readProvisionError(response)
    return {
      status: "no_cloud_repo",
      detail: `${repo} isn't on Smithers Cloud yet, so there is no workspace to provision for it.`
    }
  }
  /*
   * The pool says no, in the second shape it has: `429 quota_exceeded /
   * concurrent sandboxes limit reached`, caught live on canary. It is the same
   * truth as the 500 `no_capacity` below and deserves the same honest state —
   * leaking "answered HTTP 429: {…}" is exactly the raw failure §4 is about.
   */
  if (response.status === 429) {
    await readProvisionError(response)
    return {
      status: "no_capacity",
      detail: "Smithers Cloud has no free workspace capacity right now — nothing was queued; try again in a bit."
    }
  }
  if (!response.ok) {
    const detail = await readProvisionError(response)
    if (response.status === 500 && detail.includes("no_capacity")) {
      return {
        status: "no_capacity",
        detail: "Smithers Cloud has no free workspace capacity right now — nothing was queued; try again in a bit."
      }
    }
    return {
      status: "unavailable",
      detail: `Provisioning the workspace answered HTTP ${response.status}${detail === "" ? "." : `: ${detail}`}`
    }
  }
  const body = (await response.json().catch(() => undefined)) as
    | {
      base_url?: unknown
      token?: unknown
      expires_at?: unknown
      gateway_id?: unknown
      vm_id?: unknown
      workspace_id?: unknown
    }
    | undefined
  if (
    body === undefined ||
    typeof body.base_url !== "string" ||
    typeof body.token !== "string" ||
    typeof body.gateway_id !== "string" ||
    typeof body.expires_at !== "string" ||
    body.workspace_id !== workspaceId
  ) {
    return { status: "unavailable", detail: "Provisioning answered in a shape the gateway seam did not understand." }
  }
  const expiresAt = Date.parse(body.expires_at)
  const now = Date.now()
  const record: GatewayRecord = {
    gatewayId: body.gateway_id,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    baseUrl: body.base_url,
    token: body.token,
    vmId: typeof body.vm_id === "string" ? body.vm_id : null,
    // §5: expires_at is a re-resolve cadence, not a credential lifetime.
    // Re-call at the midpoint of the issued window (half-life), with a sane
    // floor so a bogus upstream timestamp cannot spin the provision loop.
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 60 * 60 * 1000,
    renewAfter: Number.isFinite(expiresAt) ? now + Math.max((expiresAt - now) / 2, 60 * 1000) : now + 30 * 60 * 1000,
    provisionedAt: now
  }
  return { status: "ready", record }
}

/**
 * Resolve the caller's gateway for a repo through the owning Durable Object:
 * a cached record inside its half-life window answers directly; anything else
 * re-provisions (the §5 renew contract) and adopts whatever comes back.
 * Concurrent cold or expired misses join ONE resolution inside the registry
 * instead of each stampeding the token door and the provision route.
 */
export const ensureGateway = async (
  env: GatewayEnv,
  login: string,
  repo: string,
  force = false,
  workspaceId?: string
): Promise<ProvisionOutcome> => {
  // The routes refuse a malformed repo before reaching here; the seam refuses
  // it again so no caller can spend the Cloud token on an unintended path.
  if (!isRelayRepoName(repo) || (workspaceId !== undefined && !isGatewayWorkspaceId(workspaceId))) {
    return { status: "unavailable", detail: `${repo} is not a repository this seam can address.` }
  }
  let outcome: ProvisionOutcome | undefined
  try {
    const stub = env.GATEWAY_SESSIONS.get(env.GATEWAY_SESSIONS.idFromName(login))
    const response = await stub.fetch(
      new Request("https://gateway-sessions.internal/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login, repo, ...(workspaceId === undefined ? {} : { workspaceId }), force })
      })
    )
    if (!response.ok) {
      const detail = await readBoundedResponseText(response)
      return {
        status: "unavailable",
        detail: `The gateway session store answered HTTP ${response.status}${detail === "" ? "." : `: ${detail}`}`
      }
    }
    outcome = (await response.json().catch(() => undefined)) as ProvisionOutcome | undefined
  } catch (error) {
    return {
      status: "unavailable",
      detail: `The gateway session store is unavailable: ${error instanceof Error ? error.message : "unknown error"}`
    }
  }
  if (outcome === undefined || typeof outcome.status !== "string") {
    return { status: "unavailable", detail: "The gateway session store answered in a shape the gateway seam did not understand." }
  }
  return outcome
}

/*
 * A relay answer that is the TUNNEL failing, not the engine answering. §5: a
 * workspace VM idle-suspends after 30 minutes and the gateway row stays
 * `running`, so the relay keeps accepting the call and then cannot reach
 * anything behind it — proven live on canary, where every call to a resumed-
 * hours-ago gateway came back as a Cloudflare 502 and the run card sat in
 * "reconnecting" until the record aged out. Re-POSTing the provision route is
 * what resumes the VM, so this is stale state, not a dead end.
 */
const isTunnelFailure = (status: number): boolean => status === 502 || status === 503 || status === 504

/**
 * How long a freshly minted record is trusted before another tunnel failure may
 * force a second re-provision. Without it an EventSource that reconnects every
 * few seconds would stampede the provision route — exactly what §5 forbids.
 */
const FORCED_REPROVISION_FLOOR_MS = 30_000

/**
 * The gateway mounts the relay may address. Nothing else is reachable, so a
 * path assembled from anything the browser sent can never aim the user's
 * server-held credential somewhere this seam never allowlisted.
 */
export const GATEWAY_RELAY_PATHS: ReadonlyArray<string> = ["/rpc", "/projections", "/health"]

export type GatewayCallOutcome =
  | { readonly status: "ok"; readonly response: Response }
  | { readonly status: "unknown_outcome"; readonly detail: string }
  | { readonly status: "provisioning"; readonly detail: string }
  | { readonly status: "no_capacity"; readonly detail: string }
  | { readonly status: "no_cloud_token"; readonly detail: string }
  | { readonly status: "no_cloud_repo"; readonly detail: string }
  | { readonly status: "unavailable"; readonly detail: string }

/**
 * Call the per-user gateway through the relay: the Worker holds the token and
 * sets the Authorization header (a browser never can). A 401 from the relay
 * forces a re-provision and retries exactly once (§5: the VM can be
 * reprovisioned under a live token; the fresh record is always adopted).
 *
 * `provision: false` is the read-only relay: it asks the box the login
 * already holds and never provisions or resumes one. A missing record, a
 * record past its half-life, a 401, a tunnel failure, or an unreachable
 * base_url all answer `unavailable`, so a route that only reads state can
 * ask "what does the box say?" without spending the caller's Cloud resources
 * or waking a suspended VM to answer.
 */
export const callGateway = async (
  env: GatewayEnv,
  login: string,
  repo: string,
  path: string,
  init: {
    readonly method: string
    readonly body?: unknown
    /** A body forwarded byte for byte, for the RPC mounts. */
    readonly text?: string
    readonly headers?: Record<string, string>
    /** Whether this call may be replayed after an ambiguous transport or tunnel failure. */
    readonly replayable?: boolean
    /**
     * Whether this call may provision or resume a box (the default). `false`
     * relays to the box the login already holds, once, and reports every
     * stale-record signal as `unavailable` instead of re-provisioning.
     */
    readonly provision?: boolean
    readonly workspaceId?: string
  }
): Promise<GatewayCallOutcome> => {
  // The relay addresses the gateway's own mounts and nothing else. Without
  // this, a path assembled from anything the browser sent would aim the
  // user's server-held credential wherever that string pointed.
  if (!GATEWAY_RELAY_PATHS.includes(path)) {
    return { status: "unavailable", detail: `${path} is not a gateway path this seam relays.` }
  }
  /** Why the last attempt could not reach the gateway — stated, never swallowed. */
  let reason: string | undefined
  const attempt = async (record: GatewayRecord): Promise<Response | undefined> => {
    try {
      // The relay base_url is a PATH base (…/api/gateways/<id>): URL-joining
      // an absolute path would drop it, so concatenate instead.
      return await withDeadline(
        "The workspace gateway",
        (signal) => fetch(`${record.baseUrl.replace(/\/+$/, "")}${path}`, {
          signal,
          method: init.method,
          headers: {
            authorization: `Bearer ${record.token}`,
            ...(init.body === undefined && init.text === undefined ? {} : { "content-type": "application/json" }),
            ...init.headers
          },
          ...(init.text === undefined
            ? init.body === undefined ? {} : { body: JSON.stringify(init.body) }
            : { body: init.text })
        }),
        upstreamTimeoutMs(env)
      )
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }
  if (init.provision === false) {
    const record = await readRecord(env, login, repo, init.workspaceId)
    if (record === undefined || Date.now() >= record.renewAfter) {
      return { status: "unavailable", detail: "No live workspace holds an answer for this read." }
    }
    const response = await attempt(record)
    if (response === undefined) {
      return {
        status: "unavailable",
        detail: `The workspace gateway is unreachable${reason === undefined ? "." : `: ${reason}`}`
      }
    }
    if (response.status === 401 || isTunnelFailure(response.status)) {
      // Stale record: the next provisioning call refreshes it. A read does not.
      await response.body?.cancel()
      return { status: "unavailable", detail: `The workspace gateway answered HTTP ${response.status} to a read.` }
    }
    return { status: "ok", response }
  }
  const gateway = await ensureGateway(env, login, repo, false, init.workspaceId)
  if (gateway.status !== "ready") return gateway
  let response = await attempt(gateway.record)
  /*
   * Three things force exactly ONE re-provision, all from §5: a 401 (the VM
   * was reprovisioned under a live token), an unreachable base_url, and a
   * relay tunnel failure (the VM idle-suspended or was recycled behind a row
   * that still reads `running`). Either way the cached record is stale and
   * the fresh one is adopted — "never cache the token past a gateway_id
   * change". One retry, never a loop.
   */
  const tunnelFailed = response !== undefined && isTunnelFailure(response.status)
  if (response === undefined || response.status === 401 || tunnelFailed) {
    // A record minted moments ago has already had its chance: re-POSTing
    // again cannot resume anything and would only stampede the route.
    if (
      tunnelFailed &&
      response !== undefined &&
      Date.now() - gateway.record.provisionedAt < FORCED_REPROVISION_FLOOR_MS
    ) {
      return { status: "ok", response }
    }
    if (response !== undefined) await response.body?.cancel()
    const renewed = await ensureGateway(env, login, repo, true, init.workspaceId)
    // Losing the headers does not establish whether the command was accepted.
    // Renew for subsequent callers, but preserve that uncertainty even if
    // renewal fails: its outcome says nothing about the original command.
    if (response === undefined && init.replayable === false) {
      return {
        status: "unknown_outcome",
        detail: `The workspace command may have been accepted, but its response was lost. It was not replayed${
          reason === undefined ? "." : `: ${reason}`
        }`
      }
    }
    if (renewed.status !== "ready") return renewed
    /*
     * A tunnel failure can also mean the engine took the write and only the
     * answer was lost, so a call that a repeat could duplicate is NOT
     * replayed: the gateway is resumed for the next one and this attempt is
     * reported as what it was.
     */
    if (tunnelFailed && init.replayable === false) {
      return {
        status: "unavailable",
        detail: "Your workspace had gone to sleep. It is awake again — ask me once more."
      }
    }
    response = await attempt(renewed.record)
  }
  if (response === undefined) {
    return {
      status: "unavailable",
      detail: `The workspace gateway is unreachable${reason === undefined ? "." : `: ${reason}`}`
    }
  }
  return { status: "ok", response }
}
