import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import { runDurable } from "./Boundary"
import { configLayer, ServerConfig } from "./Config"
import type { ServerEnvVars } from "./Config"
import { DurableStorage, namespaceCall, storageLayer } from "./DurableStorage"
import type { NativeNamespace, NativeStorage } from "./DurableStorage"
import { BodyUnreadable } from "./Failures"
import type { UpstreamFailure } from "./Failures"
import { discardBody, fetchWithDeadline, readJsonOrUndefined, readText, TransportLive } from "./Http"
import type { Transport } from "./Http"

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
 *
 * Every call out of this seam is bounded (`ServerConfig.upstreamTimeoutMs`,
 * headers only). Smithers Cloud accepts the provision POST and can then take
 * an unbounded time to build a sandbox: on canary the route never answered at
 * all, so `POST /api/workflow/provision` hung past 70s and the product left
 * "Preparing your <repo> workspace…" standing with no timeout, no run card and
 * no error (repro apps/app/canary-repros/honesty/22.6). A deadline turns that
 * into one of the seam's own honest states.
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

/** The persisted row: `provisionedAt` is absent on records written before it existed. */
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

/** The Durable Object storage key: a persisted identity, never changed. */
const storageKey = (repo: string, workspaceId?: string): string => `gateway:${workspaceRecordKey(repo, workspaceId)}`

/*
 * Canonical non-nil lowercase UUID text; matches the Plue route. Upstream
 * main (b40e8f6523) moved this guard to `@smthrs/rpc/GatewayWorkspace`; this
 * checkout's packages/rpc does not carry that file yet, so the guard stays
 * here until it lands, then becomes an import + re-export.
 */
export const isGatewayWorkspaceId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000"

const answer = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

/*
 * The record as the registry reads it back: a row written before
 * `provisionedAt` existed is old by definition, so it has already earned the
 * right to be re-provisioned on a tunnel failure.
 */
const recordFromRow = (row: GatewayRecordRow | null | undefined): GatewayRecord | undefined =>
  row === undefined || row === null
    ? undefined
    : { ...row, provisionedAt: typeof row.provisionedAt === "number" ? row.provisionedAt : 0 }

/**
 * The resolutions one registry object has in flight, keyed exactly like the
 * record they mint. workerd runs one instance per login, so this map is the
 * join point: concurrent cold or expired misses for one login/repo share a
 * single token-door + provision sequence, and every joiner reads back the
 * record the leader persisted. The native class creates it once per object
 * (a per-request map would join nothing); the Alchemy export does the same.
 */
export class GatewayResolutions
  extends Context.Service<GatewayResolutions, Map<string, Deferred.Deferred<ProvisionOutcome>>>()("smithers-server/GatewayResolutions") {}

export const makeGatewayResolutions = (): Map<string, Deferred.Deferred<ProvisionOutcome>> => new Map()

export const gatewayResolutionsLayer = (resolutions: Map<string, Deferred.Deferred<ProvisionOutcome>>): Layer.Layer<GatewayResolutions> =>
  Layer.succeed(GatewayResolutions, resolutions)

/** Everything the registry object runs under: its storage, the deployment's config and transport, its join map. */
export type GatewayRegistryServices = DurableStorage | Transport | ServerConfig | GatewayResolutions

/**
 * The Layer one registry object runs under, built ONCE per in-memory object
 * (the join map is the object's memory). `env` is the deployment's vars and
 * secrets: the registry mints the Cloud token and provisions the workspace
 * itself, so it needs the identity door, the Cloud origin and the deadline.
 */
export const gatewayRegistryLayers = (storage: NativeStorage, env: ServerEnvVars): Layer.Layer<GatewayRegistryServices> =>
  Layer.mergeAll(storageLayer(storage), configLayer(env), TransportLive, gatewayResolutionsLayer(makeGatewayResolutions()))

/** A record the object holds, or undefined: a store that cannot answer a read is cold, as the Worker side treats it. */
const readStored = (repo: string, workspaceId: string | undefined): Effect.Effect<GatewayRecord | undefined, never, DurableStorage> =>
  DurableStorage.use((storage) => storage.get<GatewayRecordRow>(storageKey(repo, workspaceId))).pipe(
    Effect.map(recordFromRow),
    Effect.catch(() => Effect.succeed(undefined))
  )

/**
 * The leader's half of a resolution: the Cloud token door, the provision
 * POST, exactly one re-mint on a 401, then persistence. A record that cannot
 * be stored is not reported ready.
 */
const provisionAndStore = (
  login: string,
  repo: string,
  workspaceId: string | undefined
): Effect.Effect<ProvisionOutcome, never, DurableStorage | Transport | ServerConfig> =>
  Effect.gen(function* () {
    const outcome = yield* provisionWithRemint(login, repo, workspaceId)
    if (outcome.status !== "ready") return outcome
    const storage = yield* DurableStorage
    const stored = yield* Effect.result(storage.put(storageKey(repo, workspaceId), outcome.record))
    if (Result.isFailure(stored)) {
      return {
        status: "unavailable",
        detail: `The gateway session store is unavailable: ${
          stored.failure.cause instanceof Error ? stored.failure.cause.message : "unknown error"
        }`
      } as const
    }
    return outcome
  })

/**
 * The §5 provision-or-resume cadence, coordinated per login/repo inside the
 * object: a cached record inside its half-life answers directly; anything
 * else joins the in-flight resolution if one exists, and only the first
 * caller provisions. A joiner re-reads what the leader persisted rather than
 * trusting the join: the stored record is the hand-off a recreated instance
 * would serve. The leader's work is detached from its request, so a caller
 * that hangs up mid-provision leaves the (idempotent, deadline-bounded)
 * provision to finish for the others.
 */
const resolveRecord = (
  login: string,
  repo: string,
  workspaceId: string | undefined,
  force: boolean
): Effect.Effect<ProvisionOutcome, never, GatewayRegistryServices> =>
  Effect.gen(function* () {
    if (!force) {
      const cached = yield* readStored(repo, workspaceId)
      const now = yield* Clock.currentTimeMillis
      if (cached !== undefined && now < cached.renewAfter) return { status: "ready", record: cached } as const
    }
    const key = storageKey(repo, workspaceId)
    const resolutions = yield* GatewayResolutions
    const pending = resolutions.get(key)
    if (pending !== undefined) {
      const outcome = yield* Deferred.await(pending)
      if (outcome.status !== "ready") return outcome
      const persisted = yield* readStored(repo, workspaceId)
      return persisted === undefined ? outcome : { status: "ready", record: persisted } as const
    }
    // Claimed in one synchronous step: no other caller can slip between the
    // lookup above and this registration.
    const claimed = yield* Effect.sync(() => {
      const deferred = Deferred.makeUnsafe<ProvisionOutcome>()
      resolutions.set(key, deferred)
      return deferred
    })
    yield* Effect.forkDetach(
      provisionAndStore(login, repo, workspaceId).pipe(
        // Cleared only once the record write inside the task has settled, so
        // a later caller either joins this task or reads the fresh record.
        Effect.ensuring(Effect.sync(() => {
          resolutions.delete(key)
        })),
        Effect.flatMap((outcome) => Deferred.succeed(claimed, outcome))
      )
    )
    return yield* Deferred.await(claimed)
  })

/**
 * Per-user gateway records, one Durable Object per login, keyed inside by
 * repo. The record carries the relay token, so it must never leave the
 * server: the read route is consumed by this Worker's own handlers only.
 *
 * The registry is also where a resolution is COORDINATED (`POST /resolve`):
 * see `resolveRecord`. The persisted key layout (`gateway:<repo>` and
 * `gateway:<repo>\u0000<workspaceId>`) is the deployed namespace's and
 * never changes.
 */
export const gatewaySessionRequest = (request: Request): Effect.Effect<Response, never, GatewayRegistryServices> =>
  Effect.gen(function* () {
    const storage = yield* DurableStorage
    const url = new URL(request.url)
    if (url.pathname === "/record" && request.method === "GET") {
      const repo = url.searchParams.get("repo") ?? ""
      const record = yield* storage.get<GatewayRecordRow>(storageKey(repo, url.searchParams.get("workspace_id") ?? undefined))
      return answer({ record: record ?? null })
    }
    if (url.pathname === "/record" && request.method === "PUT") {
      const body = (yield* readJsonOrUndefined(request)) as
        | { repo?: unknown; workspaceId?: unknown; record?: unknown }
        | undefined
      if (
        typeof body?.repo !== "string" || body.repo === "" || typeof body.record !== "object" || body.record === null
      ) {
        return new Response("bad request", { status: 400 })
      }
      yield* storage.put(storageKey(body.repo, typeof body.workspaceId === "string" ? body.workspaceId : undefined), body.record)
      return answer({ ok: true })
    }
    if (url.pathname === "/resolve" && request.method === "POST") {
      const body = (yield* readJsonOrUndefined(request)) as
        | { login?: unknown; repo?: unknown; workspaceId?: unknown; force?: unknown }
        | undefined
      if (typeof body?.login !== "string" || body.login === "" || typeof body.repo !== "string" || body.repo === "") {
        return new Response("bad request", { status: 400 })
      }
      const outcome = yield* resolveRecord(
        body.login,
        body.repo,
        typeof body.workspaceId === "string" ? body.workspaceId : undefined,
        body.force === true
      )
      return answer(outcome)
    }
    return new Response("not found", { status: 404 })
  }).pipe(
    // A storage failure inside the object answers 500 with its message, so
    // the Worker side reports "the session store answered HTTP 500: …"
    // rather than the object's fetch rejecting.
    Effect.catchTag("StorageFailure", (failure) => Effect.succeed(new Response(failure.message, { status: 500 })))
  )

/**
 * The native class, as workerd constructs it: `(ctx, env)`. The join map is
 * a field, made once per object; the config and transport come from the
 * deployment's env.
 */
export class GatewaySessionRegistry {
  private readonly services: Layer.Layer<GatewayRegistryServices>

  constructor(ctx: { readonly storage: NativeStorage }, env: ServerEnvVars = {}) {
    this.services = gatewayRegistryLayers(ctx.storage, env)
  }

  fetch(request: Request): Promise<Response> {
    return runDurable(gatewaySessionRequest(request).pipe(Effect.provide(this.services)))
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

/*
 * The Worker-side view of the registry: read a record, or ask the login's
 * object to resolve one (the §5 cadence, coordinated in the object). Both
 * answer through the login's Durable Object; there is no other store.
 */
export interface GatewaySessionsShape {
  readonly read: (login: string, repo: string, workspaceId?: string) => Effect.Effect<GatewayRecord | undefined>
  readonly resolve: (login: string, repo: string, workspaceId: string | undefined, force: boolean) => Effect.Effect<ProvisionOutcome>
}

export class GatewaySessions extends Context.Service<GatewaySessions, GatewaySessionsShape>()("smithers-server/GatewaySessions") {}

/**
 * The first `limit` characters of a response body, for an error detail. A
 * long body is cut, not refused (a 500 past the ceiling must still show its
 * `no_capacity`), and a body that cannot be read is simply absent.
 */
const readBoundedResponseText = (response: Response, limit = 240): Effect.Effect<string> => {
  const stream = response.body
  if (stream === null) return Effect.succeed("")
  return Effect.acquireUseRelease(
    Effect.sync(() => ({ reader: stream.getReader(), finished: false })),
    (held) =>
      Effect.gen(function* () {
        const decoder = new TextDecoder()
        let detail = ""
        const read = Effect.tryPromise({ try: () => held.reader.read(), catch: (cause) => new BodyUnreadable({ cause }) })
        for (;;) {
          const { done, value } = yield* read
          if (done) {
            held.finished = true
            break
          }
          detail += decoder.decode(value, { stream: true })
          if (detail.length >= limit) break
        }
        return detail.slice(0, limit).trim()
      }),
    (held) =>
      Effect.promise(() => (held.finished ? Promise.resolve() : held.reader.cancel().catch(() => undefined))).pipe(
        Effect.ensuring(Effect.sync(() => held.reader.releaseLock()))
      )
  ).pipe(Effect.catch(() => Effect.succeed("")))
}

const isProvisionOutcome = (value: unknown): value is ProvisionOutcome =>
  typeof value === "object" && value !== null && typeof (value as { status?: unknown }).status === "string"

const durableGatewaySessions = (namespace: NativeNamespace): GatewaySessionsShape => ({
  read: (login, repo, workspaceId) =>
    Effect.gen(function* () {
      const response = yield* namespaceCall(
        "gateway.ts:read",
        namespace,
        login,
        new Request(
          `https://gateway-sessions.internal/record?repo=${encodeURIComponent(repo)}${
            workspaceId === undefined ? "" : `&workspace_id=${encodeURIComponent(workspaceId)}`
          }`
        )
      )
      const body = (yield* readJsonOrUndefined(response)) as { record?: GatewayRecordRow | null } | undefined
      const record = body?.record
      if (record === undefined || record === null || record.workspaceId !== workspaceId) return undefined
      return recordFromRow(record)
    }).pipe(Effect.catch(() => Effect.succeed(undefined))),
  resolve: (login, repo, workspaceId, force) =>
    Effect.gen(function* () {
      const answered = yield* Effect.result(namespaceCall(
        "gateway.ts:resolve",
        namespace,
        login,
        new Request("https://gateway-sessions.internal/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ login, repo, ...(workspaceId === undefined ? {} : { workspaceId }), force })
        })
      ))
      if (Result.isFailure(answered)) {
        return {
          status: "unavailable",
          detail: `The gateway session store is unavailable: ${
            answered.failure.cause instanceof Error ? answered.failure.cause.message : "unknown error"
          }`
        } as const
      }
      const response = answered.success
      if (!response.ok) {
        const detail = yield* readBoundedResponseText(response)
        return {
          status: "unavailable",
          detail: `The gateway session store answered HTTP ${response.status}${detail === "" ? "." : `: ${detail}`}`
        } as const
      }
      const outcome = yield* readJsonOrUndefined(response)
      if (!isProvisionOutcome(outcome)) {
        return { status: "unavailable", detail: "The gateway session store answered in a shape the gateway seam did not understand." } as const
      }
      return outcome
    })
})

/** The session store: the login's Durable Object. Bound on every deployment; tests bind the real class over memory. */
export const gatewaySessionsLayer = (namespace: NativeNamespace): Layer.Layer<GatewaySessions> =>
  Layer.succeed(GatewaySessions, durableGatewaySessions(namespace))

/**
 * The sentence an upstream failure is reported with: the cause's own message
 * where it has one, and the configured deadline in milliseconds (the number
 * the deployment set, never a rounded second) when the deadline won.
 */
const failureMessage = (failure: UpstreamFailure): string =>
  failure._tag === "UpstreamTimeout"
    ? `${failure.seam} did not answer within ${failure.timeoutMs}ms.`
    : failure.cause instanceof Error
    ? failure.cause.message
    : "unknown error"

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
export const fetchCloudToken = (login: string): Effect.Effect<CloudTokenOutcome, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.identityUpstreamUrl === undefined) {
      return { status: "not_configured", detail: "IDENTITY_UPSTREAM_URL is unset on this deployment." } as const
    }
    if (config.identityServiceToken === undefined) {
      return { status: "not_configured", detail: "IDENTITY_SERVICE_TOKEN is unset on this deployment." } as const
    }
    const answered = yield* Effect.result(fetchWithDeadline(
      "The Cloud token door",
      new URL("/api/identity/cloud-token", config.identityUpstreamUrl).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-smithers-service-token": Redacted.value(config.identityServiceToken) },
        body: JSON.stringify({ login })
      },
      config.upstreamTimeoutMs
    ))
    if (Result.isFailure(answered)) {
      return {
        status: "unavailable",
        detail: `The identity service is unreachable: ${failureMessage(answered.failure)}`
      } as const
    }
    const response = answered.success
    if (!response.ok) {
      const detail = (yield* readText(response).pipe(Effect.catch(() => Effect.succeed("")))).trim().slice(0, 200)
      return {
        status: "unavailable",
        detail: `The Cloud token door answered HTTP ${response.status}${detail === "" ? "." : `: ${detail}`}`
      } as const
    }
    const body = (yield* readJsonOrUndefined(response)) as
      | { found?: unknown; token?: unknown; cloud?: { status?: unknown; reason?: unknown } }
      | undefined
    if (body?.found === true && typeof body.token === "string" && body.token !== "") {
      return { status: "ok", token: body.token } as const
    }
    const cloudStatus = typeof body?.cloud?.status === "string" ? body.cloud.status : "unknown"
    const cloudReason = typeof body?.cloud?.reason === "string" ? body.cloud.reason : null
    return {
      status: "not_found",
      detail: `No Smithers Cloud identity is available for this account (${cloudStatus}${
        cloudReason === null ? "" : `: ${cloudReason}`
      }).`
    } as const
  })

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

const NO_CAPACITY_DETAIL = "Smithers Cloud has no free workspace capacity right now — nothing was queued; try again in a bit."

/**
 * Provision-or-resume (§5): POST {cloud}/api/repos/{owner}/{repo}/gateway with
 * the user's Cloud token. Idempotent; on success ALWAYS adopt the returned
 * gateway_id/token/base_url. The taxonomy: 401 = the Cloud token was rejected
 * (the caller may re-mint and retry once), 409 = mid-provision (poll, don't
 * stampede), 500 no_capacity = pool exhausted (surface honestly, never
 * retry-loop).
 */
const provisionGateway = (
  repo: string,
  cloudToken: string,
  workspaceId?: string
): Effect.Effect<ProvisionOutcome | { readonly status: "cloud_token_rejected" }, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const answered = yield* Effect.result(fetchWithDeadline(
      "Smithers Cloud",
      new URL(`/api/repos/${repo}/gateway`, config.cloudApiBaseUrl).toString(),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${cloudToken}`,
          ...(workspaceId === undefined ? {} : { "content-type": "application/json" })
        },
        ...(workspaceId === undefined ? {} : { body: JSON.stringify({ workspace_id: workspaceId }) })
      },
      config.upstreamTimeoutMs
    ))
    if (Result.isFailure(answered)) {
      /*
       * A provision POST that never answers is not a dead end: the route is
       * idempotent, and Cloud may well still be building the sandbox behind
       * the silence. So a deadline lands in the seam's `provisioning` state —
       * the caller polls to its own bounded deadline and then says so — and
       * only a real connection failure is reported as unreachable. Either way
       * the request ANSWERS, which is the whole point.
       */
      if (answered.failure._tag === "UpstreamTimeout") {
        return {
          status: "provisioning",
          detail: `Smithers Cloud hasn't finished preparing the workspace for ${repo} yet — it took longer than ${
            answered.failure.timeoutMs
          }ms to answer.`
        } as const
      }
      return {
        status: "unavailable",
        detail: `Smithers Cloud is unreachable: ${failureMessage(answered.failure)}`
      } as const
    }
    const response = answered.success
    if (response.status === 401) {
      yield* discardBody(response)
      return { status: "cloud_token_rejected" } as const
    }
    if (response.status === 409) {
      const refusal = (yield* readJsonOrUndefined(response)) as { code?: unknown; message?: unknown } | undefined
      return {
        status: refusal?.code === "coding_host_unavailable" ? "unavailable" : "provisioning",
        detail: typeof refusal?.message === "string" ? refusal.message : `The workspace for ${repo} is still being prepared.`
      } as const
    }
    if (response.status === 404) {
      yield* readBoundedResponseText(response)
      return {
        status: "no_cloud_repo",
        detail: `${repo} isn't on Smithers Cloud yet, so there is no workspace to provision for it.`
      } as const
    }
    /*
     * The pool says no, in the second shape it has: `429 quota_exceeded /
     * concurrent sandboxes limit reached`, caught live on canary. It is the same
     * truth as the 500 `no_capacity` below and deserves the same honest state —
     * leaking "answered HTTP 429: {…}" is exactly the raw failure §4 is about.
     */
    if (response.status === 429) {
      yield* readBoundedResponseText(response)
      return { status: "no_capacity", detail: NO_CAPACITY_DETAIL } as const
    }
    if (!response.ok) {
      const detail = yield* readBoundedResponseText(response)
      if (response.status === 500 && detail.includes("no_capacity")) {
        return { status: "no_capacity", detail: NO_CAPACITY_DETAIL } as const
      }
      return {
        status: "unavailable",
        detail: `Provisioning the workspace answered HTTP ${response.status}${detail === "" ? "." : `: ${detail}`}`
      } as const
    }
    const body = (yield* readJsonOrUndefined(response)) as
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
      return { status: "unavailable", detail: "Provisioning answered in a shape the gateway seam did not understand." } as const
    }
    const expiresAt = Date.parse(body.expires_at)
    const now = yield* Clock.currentTimeMillis
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
    return { status: "ready", record } as const
  })

/**
 * Resolve the caller's gateway for a repo through the owning Durable Object:
 * a cached record inside its half-life window answers directly; anything else
 * re-provisions (the §5 renew contract) and adopts whatever comes back.
 * Concurrent cold or expired misses join ONE resolution inside the registry
 * instead of each stampeding the token door and the provision route.
 */
export const ensureGateway = (
  login: string,
  repo: string,
  force = false,
  workspaceId?: string
): Effect.Effect<ProvisionOutcome, never, GatewaySessions> =>
  Effect.gen(function* () {
    // The routes refuse a malformed repo before reaching here; the seam refuses
    // it again so no caller can spend the Cloud token on an unintended path.
    if (!isRelayRepoName(repo) || (workspaceId !== undefined && !isGatewayWorkspaceId(workspaceId))) {
      return { status: "unavailable", detail: `${repo} is not a repository this seam can address.` } as const
    }
    const sessions = yield* GatewaySessions
    return yield* sessions.resolve(login, repo, workspaceId, force)
  })

/** The token door, the provision POST, and exactly one re-mint on a 401 (the registry's leader runs this). */
const provisionWithRemint = (
  login: string,
  repo: string,
  workspaceId?: string
): Effect.Effect<ProvisionOutcome, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const cloudToken = yield* fetchCloudToken(login)
    if (cloudToken.status !== "ok") {
      if (cloudToken.status === "not_found") return { status: "no_cloud_token", detail: cloudToken.detail } as const
      return { status: "unavailable", detail: cloudToken.detail } as const
    }
    const first = yield* provisionGateway(repo, cloudToken.token, workspaceId)
    if (first.status !== "cloud_token_rejected") return first
    // The vaulted Cloud token was rejected (plue-side expiry/revocation): the
    // door re-exchanges from the vaulted GitHub token, so one fresh mint may
    // legitimately succeed. More than one retry would be a loop.
    const reminted = yield* fetchCloudToken(login)
    if (reminted.status !== "ok") {
      return reminted.status === "not_found"
        ? { status: "no_cloud_token", detail: reminted.detail } as const
        : { status: "unavailable", detail: reminted.detail } as const
    }
    const second = yield* provisionGateway(repo, reminted.token, workspaceId)
    if (second.status === "cloud_token_rejected") {
      return { status: "unavailable", detail: "Smithers Cloud rejected a freshly minted identity token." } as const
    }
    return second
  })

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

export interface GatewayCallInit {
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

/** One relay attempt; a failure is the sentence stating why, never swallowed. */
const relayAttempt = (
  record: GatewayRecord,
  path: string,
  init: GatewayCallInit
): Effect.Effect<Result.Result<Response, string>, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    // The relay base_url is a PATH base (…/api/gateways/<id>): URL-joining
    // an absolute path would drop it, so concatenate instead.
    return yield* fetchWithDeadline(
      "The workspace gateway",
      `${record.baseUrl.replace(/\/+$/, "")}${path}`,
      {
        method: init.method,
        headers: {
          authorization: `Bearer ${record.token}`,
          ...(init.body === undefined && init.text === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers
        },
        ...(init.text === undefined
          ? init.body === undefined ? {} : { body: JSON.stringify(init.body) }
          : { body: init.text })
      },
      config.upstreamTimeoutMs
    )
  }).pipe(
    Effect.map((response) => Result.succeed(response)),
    Effect.catch((failure) => Effect.succeed(Result.fail(failureMessage(failure))))
  )

const unreachable = (reason: string | undefined): GatewayCallOutcome => ({
  status: "unavailable",
  detail: `The workspace gateway is unreachable${reason === undefined ? "." : `: ${reason}`}`
})

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
export const callGateway = (
  login: string,
  repo: string,
  path: string,
  init: GatewayCallInit
): Effect.Effect<GatewayCallOutcome, never, Transport | ServerConfig | GatewaySessions> =>
  Effect.gen(function* () {
    // The relay addresses the gateway's own mounts and nothing else. Without
    // this, a path assembled from anything the browser sent would aim the
    // user's server-held credential wherever that string pointed.
    if (!GATEWAY_RELAY_PATHS.includes(path)) {
      return { status: "unavailable", detail: `${path} is not a gateway path this seam relays.` } as const
    }
    if (init.provision === false) {
      const sessions = yield* GatewaySessions
      const record = yield* sessions.read(login, repo, init.workspaceId)
      const now = yield* Clock.currentTimeMillis
      if (record === undefined || now >= record.renewAfter) {
        return { status: "unavailable", detail: "No live workspace holds an answer for this read." } as const
      }
      const attempted = yield* relayAttempt(record, path, init)
      if (Result.isFailure(attempted)) return unreachable(attempted.failure)
      const response = attempted.success
      if (response.status === 401 || isTunnelFailure(response.status)) {
        // Stale record: the next provisioning call refreshes it. A read does not.
        yield* discardBody(response)
        return { status: "unavailable", detail: `The workspace gateway answered HTTP ${response.status} to a read.` } as const
      }
      return { status: "ok", response } as const
    }
    const gateway = yield* ensureGateway(login, repo, false, init.workspaceId)
    if (gateway.status !== "ready") return gateway
    const first = yield* relayAttempt(gateway.record, path, init)
    /*
     * Three things force exactly ONE re-provision, all from §5: a 401 (the VM
     * was reprovisioned under a live token), an unreachable base_url, and a
     * relay tunnel failure (the VM idle-suspended or was recycled behind a row
     * that still reads `running`). Either way the cached record is stale and
     * the fresh one is adopted — "never cache the token past a gateway_id
     * change". One retry, never a loop.
     */
    const lost = Result.isFailure(first)
    const tunnelFailed = Result.isSuccess(first) && isTunnelFailure(first.success.status)
    if (!lost && first.success.status !== 401 && !tunnelFailed) return { status: "ok", response: first.success } as const
    // A record minted moments ago has already had its chance: re-POSTing
    // again cannot resume anything and would only stampede the route.
    const now = yield* Clock.currentTimeMillis
    if (tunnelFailed && now - gateway.record.provisionedAt < FORCED_REPROVISION_FLOOR_MS) {
      return { status: "ok", response: first.success } as const
    }
    if (Result.isSuccess(first)) yield* discardBody(first.success)
    const renewed = yield* ensureGateway(login, repo, true, init.workspaceId)
    // Losing the headers does not establish whether the command was accepted.
    // Renew for subsequent callers, but preserve that uncertainty even if
    // renewal fails: its outcome says nothing about the original command.
    if (Result.isFailure(first) && init.replayable === false) {
      return {
        status: "unknown_outcome",
        detail: `The workspace command may have been accepted, but its response was lost. It was not replayed: ${first.failure}`
      } as const
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
      } as const
    }
    const second = yield* relayAttempt(renewed.record, path, init)
    if (Result.isFailure(second)) return unreachable(second.failure)
    return { status: "ok", response: second.success } as const
  })
