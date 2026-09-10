import { actorSharedState } from "../ActorBindings"
/*
 * The Linear seam (lane sync, ADR 0005; lane L5 against the live routes),
 * behind the `/api/cloud/*` proxy. Every path below was read off plue's own
 * router (`cmd/server/router.go`) — the list and the delete live under
 * `/api/integrations/linear`, the runs and the ops feed under `/api/linear`:
 *
 *   GET    /api/integrations/linear          — the user's integrations (per team, last sync)
 *   DELETE /api/integrations/linear/{id}     — disconnect (204)
 *   GET    /api/linear/setup/{setupKey}      — the OAuth setup: { linear_actor, teams[], expires_at }
 *   POST   /api/linear                       — create { setup_key, linear_team_id, repo } (201)
 *   POST   /api/linear/{id}/sync             — start a sync run (202 { run_id })
 *   GET    /api/linear/{id}/sync/{runId}     — the run: { state, counts, started_at, finished_at }
 *   GET    /api/linear/{id}/ops?status=&since=&limit=&cursor= — the ops, newest
 *          first; plue#491 pages them with the Link header's opaque
 *          `rel="next"` cursor, the same keyset scheme the egress audit uses
 *   POST   /api/linear/{id}/ops/{opId}/retry — retry one failed op (202, the retry op)
 *
 * The OAuth handoff opens GET /api/auth/linear through the native
 * `openExternal` door; the local origin receives the callback (the Bun
 * server's `/api/linear-auth/*` receiver, LINEAR_AUTH_* in LocalApp.ts) and
 * the seam polls it for the setup key. The settled flow is handoff → GET
 * setup → pick → create; the card is the wizard.
 *
 * NOTHING is remapped on the way to the card: a run's state word and an op's
 * status word are the wire's own (`pending | running | completed | failed`
 * for a run, `pending | success | failed | skipped` for an op), the error is
 * `error_message` verbatim, and a failed op is never filtered out of the
 * feed. The run is polled here — a card is a projection, never a lifecycle.
 */
import {
  LINEAR_AUTH_SESSION_PATH,
  LINEAR_AUTH_START_PATH,
  LinearAuthSessionSchema,
  LinearAuthStartResponseSchema
} from "@smthrs/rpc/LocalApp"
import type { Card, LinearIntegrationInput, LinearIntegrationRow } from "../AppState"
import { linearIntegrationRepo } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
/* plue pages the ops feed with the same Link/`rel="next"` keyset scheme the egress audit uses. */
import { nextEgressCursor } from "./EgressSeam"
import { readErrorMessage } from "./SeamContext"
import { createCloudClient } from "./CloudClient"
import { createRunEpochs } from "./RunEpochs"
import type { SeamContext } from "./SeamContext"

export const SIGN_OUT_REFUSAL = "Sign in to Smithers Cloud first — /cloud.sign-in."

/** ADR 0005: an expired setup key reads this under step 1, never a silent retry. */
export const SETUP_EXPIRED_NOTE = "authorization expired · Open Linear again"
const HANDOFF_TIMEOUT_NOTE =
  "The Linear authorization didn't come back to the app — the browser step was closed or timed out. Open Linear retries it."

/**
 * The run poll: one read of the run and its ops every `delayMs`, at most
 * `maxAttempts` reads (fifteen minutes at the production cadence — plue's
 * own initial-sync timeout). Module-level so tests shorten the wait.
 */
export const linearSyncPolling = {
  delayMs: 2_000,
  maxAttempts: 450,
  networkRetries: 2
}

/**
 * The honest sign-off when polling can no longer read the run: the header
 * keeps the last state it saw, because the run keeps going upstream.
 */
export const LINEAR_LOST_STREAM_TRIGGER = "lost the run stream — /linear.sync re-reads it"

/** plue's ops feed page size; `load older` asks for its maximum (100). */
export const OPS_PAGE_LIMIT = 50
export const OPS_OLDER_LIMIT = 100

/** The run states plue's `linear_sync_runs.state` CHECK allows that mean "no longer moving". */
const RUN_SETTLED = new Set(["completed", "failed"])

export interface LinearSeamDeps {
  /** The native system-browser door; absent in a plain browser (window.open falls back). */
  readonly openExternal?: (url: string) => Promise<boolean>
  /** The handoff poll cadence while the authorization is out in the browser; tests shorten it. */
  readonly pollMs?: number
  /** The whole handoff wait; production matches the Bun side's five-minute listener. */
  readonly timeoutMs?: number
  /** The clock the 24-hour activity window is cut against; tests pin it. */
  readonly now?: () => number
}

export interface LinearSeam {
  /** `linear.connect [repo]`: upsert the connector-setup wizard card for the repository. */
  readonly connect: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** Hidden, card-scoped: step 1's Open Linear — the handoff, then the setup lookup. */
  readonly openLinear: (repo?: string) => Promise<string | void>
  /** Hidden, card-scoped: step 2's one-click team pick. */
  readonly pickTeam: (teamId: string, repo?: string) => Promise<string | void>
  /** Hidden, card-scoped: step 3's repository pick (the tree from ADR 0001). */
  readonly pickRepository: (cardRepo: string, repo: string) => Promise<string | void>
  /** `linear.connect.confirm [repo]`: post the integration and turn the card connected. */
  readonly confirmConnect: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** The integrations list load (boot and after every mutation); only definitive answers dispatch. */
  readonly refreshIntegrations: () => Promise<void>
  /** `linear.sync [integration]`: start a sync run and track it on the sync-ops card. */
  readonly syncNow: (integration?: string) => Promise<string | void | { readonly value: string }>
  /** `linear.activity [integration]`: the last 24 hours of ops, newest first. */
  readonly activity: (integration?: string) => Promise<string | void | { readonly value: string }>
  /**
   * `linear.disconnect <integration> <teamKey>`: delete the integration; the
   * connected card leaves the transcript. The team key typed back is the
   * confirm — a slash, an agent's confirmed invocation, and the card's second
   * click all carry it, and only the integration's own key disconnects.
   */
  readonly disconnect: (integration: string, confirmKey?: string) => Promise<string | void | { readonly value: string }>
  /** `sync.retry <opId>`: retry one failed op through the card that carries it. */
  readonly retryOp: (opId: string) => Promise<string | void | { readonly value: string }>
  /** Hidden, card-scoped: the sync-ops card's Show more — reveals the rows past the local cut. */
  readonly showMoreOps: (cardId: string) => Promise<string | void>
  /** Hidden, card-scoped: `load older` — re-reads the feed without the window bound. */
  readonly loadOlderOps: (cardId: string) => Promise<string | void>
}

type Step = { readonly id: string; readonly label: string; readonly state: "pending" | "active" | "done" | "error"; readonly detail: string | null; readonly error?: string }
type SetupPayload = Extract<Card, { kind: "connector-setup" }>["payload"]
type SyncPayload = Extract<Card, { kind: "sync-ops" }>["payload"]
type SyncOp = SyncPayload["ops"][number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const LINEAR_STEP_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["authorize", "Authorize in your browser"],
  ["team", "Team"],
  ["repository", "Repository"],
  ["confirm", "Confirm"]
]

const freshSteps = (repo: string): Array<Step> =>
  LINEAR_STEP_LABELS.map(([id, label], index) => ({
    id,
    label,
    state: index === 0 ? "active" : "pending",
    detail: id === "repository" ? repo : null
  }))

/** The steps with one step's patch applied (state, detail, error). */
const patchStep = (steps: ReadonlyArray<Step>, id: string, patch: Partial<Step>): Array<Step> =>
  steps.map((step) => (step.id === id ? { ...step, ...patch } : step))

const cardIdOf = (repo: string): string => `connector-setup-linear-${repo}`
const syncCardIdOf = (integrationId: string): string => `sync-ops-linear-${integrationId}`

/** One integration row off the wire (GET /api/integrations/linear); malformed rows drop. */
const parseIntegration = (value: unknown): LinearIntegrationInput | null => {
  if (!isRecord(value)) return null
  const id = intOrNull(value.id)
  if (id === null) return null
  return {
    id: String(id),
    teamId: str(value.linear_team_id) ?? "",
    teamName: str(value.linear_team_name) ?? "",
    teamKey: str(value.linear_team_key) ?? "",
    repoOwner: str(value.repo_owner) ?? "",
    repoName: str(value.repo_name) ?? "",
    active: value.is_active === true,
    remediation: str(value.remediation_state),
    lastSyncAt: str(value.last_sync_at),
    createdAt: str(value.created_at)
  }
}

interface SetupAnswer {
  readonly teams: ReadonlyArray<{ readonly id: string; readonly name: string; readonly key: string }>
  readonly expiresAt: string | null
  readonly actor: string | null
}

/**
 * The setup lookup's answer: `{ linear_actor, teams[] { id, name, key },
 * expires_at }`. plue#491 added `linear_actor`
 * (`services.LinearViewer` = `{ id, email, name }`), which is what
 * `authorized as <actor>` names — the account that just authorized access.
 * A wire that names none leaves the row reading a bare `authorized`.
 */
const parseSetup = (value: unknown): SetupAnswer | null => {
  if (!isRecord(value)) return null
  if (!Array.isArray(value.teams)) return null
  const teams = value.teams.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const id = str(entry.id)
    const name = str(entry.name)
    const key = str(entry.key)
    return id === null || name === null || key === null ? [] : [{ id, name, key }]
  })
  return { teams, expiresAt: str(value.expires_at), actor: linearActorName(value.linear_actor) ?? linearActorName(value.viewer) }
}

/**
 * The name an actor DTO is rendered by: plue's `linear_actor` carries an id,
 * an email and a name, and only one of them is a person's name. The email is
 * the fallback because it still identifies the account; the opaque Linear id
 * is never rendered as a name.
 */
const linearActorName = (value: unknown): string | null => {
  if (!isRecord(value)) return null
  return str(value.name) ?? str(value.email)
}

/**
 * One op off `GET /api/linear/{id}/ops`. plue's row is `{ id, run_id?,
 * retry_of_id?, source, target, entity, entity_id, action, status,
 * error_message, created_at }`; the status word and the error text cross
 * unchanged, and only a `failed` op offers Retry (plue refuses any other).
 */
const parseOp = (value: unknown): SyncOp | null => {
  if (!isRecord(value)) return null
  const id = intOrNull(value.id)
  if (id === null) return null
  const status = str(value.status) ?? ""
  const error = str(value.error_message)
  return {
    id: String(id),
    source: str(value.source) ?? "",
    target: str(value.target) ?? "",
    entity: str(value.entity) ?? "",
    entityId: str(value.entity_id),
    action: str(value.action) ?? "",
    status,
    ...(error !== null ? { error } : {}),
    retryable: status === "failed",
    at: str(value.created_at)
  }
}

const parseOps = (body: unknown): ReadonlyArray<SyncOp> | null =>
  Array.isArray(body) ? body.flatMap((entry) => { const op = parseOp(entry); return op === null ? [] : [op] }) : null

/**
 * The run's counts. plue answers them PER ENTITY (`{ issues: {done, total,
 * failed}, comments: {…} }`) while the card header is one `N of M · K
 * failed` line, so every bucket the wire names is summed — a third bucket
 * lands in the total without a code change. Null when no bucket parsed.
 */
export const sumRunCounts = (
  counts: unknown
): { readonly total: number; readonly done: number; readonly failed: number } | null => {
  if (!isRecord(counts)) return null
  let total = 0
  let done = 0
  let failed = 0
  let seen = false
  for (const bucket of Object.values(counts)) {
    if (!isRecord(bucket)) continue
    const bucketDone = intOrNull(bucket.done)
    const bucketTotal = intOrNull(bucket.total)
    if (bucketDone === null || bucketTotal === null) continue
    seen = true
    done += bucketDone
    total += bucketTotal
    failed += intOrNull(bucket.failed) ?? 0
  }
  return seen ? { total, done, failed } : null
}

interface RunAnswer {
  readonly state: string
  readonly counts: { readonly total: number; readonly done: number; readonly failed: number } | null
}

const parseRun = (value: unknown): RunAnswer | null => {
  if (!isRecord(value)) return null
  const state = str(value.state)
  if (state === null) return null
  return { state, counts: sumRunCounts(value.counts) }
}

export const createLinearSeam = (ctx: SeamContext, deps: LinearSeamDeps = {}): LinearSeam => {
  const pollMs = deps.pollMs ?? 2000
  const timeoutMs = deps.timeoutMs ?? 5 * 60 * 1000
  const now = deps.now ?? (() => Date.now())
  const { url: cloud, get: getJson, send: sendJson } = createCloudClient(ctx)
  /* Shared by actor bindings, never dispatched: the opening repo's card id
     stays stable even when step 3 picks another repository. */
  const setups = actorSharedState(ctx, "linear-setups", () => new Map<string, {
    readonly key: string
    timer?: ReturnType<typeof setTimeout>
  }>())
  const clearSetup = (id: string): void => {
    const setup = setups.get(id)
    if (setup?.timer !== undefined) clearTimeout(setup.timer)
    setups.delete(id)
  }
  const rememberSetup = (id: string, key: string, expiresAt: number): void => {
    clearSetup(id)
    setups.set(id, { key })
    const expire = (): void => {
      const remaining = expiresAt - now()
      if (remaining <= 0) { clearSetup(id); return }
      const setup = setups.get(id)
      // Long-lived test fixtures must not overflow the platform timer limit.
      if (setup !== undefined) setup.timer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
    }
    expire()
  }
  const redactSetupError = (message: string, key: string): string => key === "" ? message :
    message.replaceAll(encodeURIComponent(key), "[redacted]").replaceAll(key, "[redacted]")
  /* One tracking loop per integration: a re-run supersedes the loop before it. */
  const epochs = createRunEpochs(ctx, "linear-epochs")

  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return SIGN_OUT_REFUSAL
  }

  /* ---- the card ---- */

  /*
   * The wizard card an act addresses. The id is keyed on the repository the
   * wizard was OPENED on and stays put for the card's life (the SAME card
   * turns connected), while step 3 may point `payload.repo` at another
   * repository — so the card's own buttons arrive carrying the picked repo.
   * A card under that id answers first; otherwise the card whose payload
   * names the repo does. Keying the lookup on the payload's repo alone made
   * Connect fail for every pick but the default.
   */
  const findCard = (repo: string): { readonly id: string; readonly payload: SetupPayload } | undefined => {
    const direct = ctx.store.collections.cards.get(cardIdOf(repo))
    if (direct?.kind === "connector-setup" && direct.payload.connector === "linear") {
      return { id: direct.id, payload: direct.payload }
    }
    for (const card of ctx.store.collections.cards.values()) {
      if (card.kind === "connector-setup" && card.payload.connector === "linear" && card.payload.repo === repo) {
        return { id: card.id, payload: card.payload }
      }
    }
    return undefined
  }

  const upsertCard = (id: string, repo: string, patch: Partial<SetupPayload>): void => {
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "connector-setup" && existing.payload.connector === "linear" ? existing.payload : undefined
    const payload: SetupPayload = {
      connector: "linear",
      repo,
      phase: patch.phase ?? prior?.phase ?? "setup",
      steps: (patch.steps ?? prior?.steps ?? freshSteps(repo)).map((step) => ({ ...step })),
      ...(patch.setupExpiresAt !== undefined ? { setupExpiresAt: patch.setupExpiresAt } : prior?.setupExpiresAt !== undefined ? { setupExpiresAt: prior.setupExpiresAt } : {}),
      ...(patch.actor !== undefined ? { actor: patch.actor } : prior?.actor !== undefined ? { actor: prior.actor } : {}),
      ...(patch.teams !== undefined ? { teams: patch.teams.map((team) => ({ ...team })) } : prior?.teams !== undefined ? { teams: prior.teams.map((team) => ({ ...team })) } : {}),
      ...(patch.teamId !== undefined ? { teamId: patch.teamId } : prior?.teamId !== undefined ? { teamId: prior.teamId } : {}),
      ...(patch.integration !== undefined ? { integration: patch.integration } : prior?.integration !== undefined ? { integration: prior.integration } : {}),
      ...(patch.rateLimit !== undefined ? { rateLimit: patch.rateLimit } : prior?.rateLimit !== undefined ? { rateLimit: prior.rateLimit } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {})
    }
    const connected = payload.phase === "connected" && payload.integration !== undefined
    const card: Card = {
      id,
      kind: "connector-setup",
      title: connected
        ? `Linear · ${payload.integration!.teamKey} → ${repo}`
        : `Connect Linear · ${repo}`,
      status: payload.error !== undefined ? "error" : connected ? "acted" : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /* ---- the integrations list ---- */

  const refreshIntegrations = async (): Promise<void> => {
    const answer = await getJson("/integrations/linear")
    if ("error" in answer || !Array.isArray(answer.body)) return
    ctx.dispatch({
      type: "linear.integrations.loaded",
      actor: "system",
      integrations: answer.body.flatMap((entry) => {
        const parsed = parseIntegration(entry)
        return parsed === null ? [] : [parsed]
      })
    })
  }

  /*
   * The integration an act routes through: the explicit id or team key, else
   * the single loaded integration, else an honest answer naming what exists.
   * The list is re-read first so a stale collection never refuses wrongly.
   */
  const resolveIntegration = async (
    token: string | undefined
  ): Promise<{ readonly integration: LinearIntegrationRow } | { readonly error: string }> => {
    await refreshIntegrations()
    const rows = [...ctx.store.collections.linearIntegrations.values()]
    const named = token?.trim() ?? ""
    if (named !== "") {
      const found = rows.find((row) => row.id === named) ??
        rows.find((row) => row.teamKey.toLowerCase() === named.toLowerCase())
      if (found !== undefined) return { integration: found }
      return {
        error: rows.length === 0
          ? `No Linear integration named ${named} — none are connected. /linear.connect opens the card.`
          : `No Linear integration named ${named} — connected: ${rows.map((row) => `${row.teamKey} → ${linearIntegrationRepo(row)}`).join(", ")}.`
      }
    }
    if (rows.length === 1) return { integration: rows[0]! }
    if (rows.length === 0) return { error: "No Linear integration is connected — /linear.connect opens the card." }
    return {
      error: `linear.sync names an integration: ${rows.map((row) => `${row.teamKey} (${row.id}) → ${linearIntegrationRepo(row)}`).join(", ")}.`
    }
  }

  /* ---- the sync-ops card ---- */

  /**
   * The sync-ops card for one integration, patched; unset keys keep their
   * last values — except under two options, because two acts must REMOVE a
   * field rather than overwrite it: `load older` leaves the 24-hour cut (a
   * card still labelled `24h` over a wider page would be a lie), and a new
   * run inherits nothing from the run before it.
   */
  const upsertSyncCard = (
    integration: LinearIntegrationRow,
    patch: Partial<SyncPayload>,
    options: { readonly clearWindow?: boolean; readonly reset?: boolean } = {}
  ): void => {
    const id = syncCardIdOf(integration.id)
    const existing = ctx.store.collections.cards.get(id)
    const prior = options.reset === true
      ? undefined
      : existing?.kind === "sync-ops"
      ? existing.payload
      : undefined
    const repo = linearIntegrationRepo(integration)
    const payload: SyncPayload = {
      subject: `Linear ${integration.teamKey} ↔ ${repo}`,
      source: "linear",
      integrationId: integration.id,
      repo,
      runState: patch.runState !== undefined ? patch.runState : prior?.runState ?? null,
      ops: (patch.ops ?? prior?.ops ?? []).map((op) => ({ ...op })),
      ...(patch.runId !== undefined ? { runId: patch.runId } : prior?.runId !== undefined ? { runId: prior.runId } : {}),
      ...(patch.counts !== undefined ? { counts: patch.counts } : prior?.counts !== undefined ? { counts: prior.counts } : {}),
      ...(patch.trigger !== undefined ? { trigger: patch.trigger } : prior?.trigger !== undefined ? { trigger: prior.trigger } : {}),
      ...(options.clearWindow === true
        ? {}
        : patch.window !== undefined
        ? { window: patch.window }
        : prior?.window !== undefined
        ? { window: prior.window }
        : {}),
      ...(patch.expanded !== undefined ? { expanded: patch.expanded } : prior?.expanded !== undefined ? { expanded: prior.expanded } : {}),
      ...(patch.hasOlder !== undefined ? { hasOlder: patch.hasOlder } : prior?.hasOlder !== undefined ? { hasOlder: prior.hasOlder } : {}),
      ...(patch.opsCursor !== undefined ? { opsCursor: patch.opsCursor } : prior?.opsCursor !== undefined ? { opsCursor: prior.opsCursor } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {})
    }
    const card: Card = {
      id,
      kind: "sync-ops",
      title: `Sync · Linear ${integration.teamKey} ↔ ${repo}`,
      status: payload.error !== undefined ? "error" : payload.runState === "completed" ? "acted" : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /**
   * One page of the ops feed for an integration; the answer's own order
   * (newest first) is kept. plue#491 pages it with the Link header's opaque
   * `rel="next"` cursor, so the page's own position rides back with the rows
   * and `load older` continues from it instead of re-reading a wider window.
   * A last page carries only `rel="first"` and answers a null cursor.
   */
  const readOps = async (
    integrationId: string,
    query: { readonly since?: string; readonly limit: number; readonly cursor?: string | null }
  ): Promise<{ readonly ops: ReadonlyArray<SyncOp>; readonly nextCursor: string | null } | { readonly error: string }> => {
    const params = new URLSearchParams({ limit: String(query.limit) })
    if (query.since !== undefined) params.set("since", query.since)
    if (query.cursor !== undefined && query.cursor !== null && query.cursor !== "") params.set("cursor", query.cursor)
    const path = `/linear/${encodeURIComponent(integrationId)}/ops?${params.toString()}`
    const answer = await getJson(path)
    if ("error" in answer) return answer
    const ops = parseOps(answer.body)
    if (ops === null) return { error: "Smithers Cloud's answer for the Linear sync ops was malformed." }
    return {
      ops,
      nextCursor: nextEgressCursor(answer.response.headers.get("link"), path.split("?")[0] ?? path)
    }
  }

  /*
   * The run poll: the run DTO carries the header's state and counts, the ops
   * feed carries the rows, and the card is re-upserted on every pass so the
   * counts stay live while ops arrive. The loop stops when the run settles
   * (`completed`/`failed`), when a newer run supersedes it, or when the
   * budget runs out — never on an ops read that refused, which only leaves
   * the last rows standing, and never on a dropped run read, which is
   * retried up to `networkRetries` times.
   */
  const trackRun = async (integration: LinearIntegrationRow, runId: string, epoch: number): Promise<void> => {
    const settle = (): void => epochs.settle(integration.id, epoch)
    let drops = 0
    for (let attempt = 0; attempt < linearSyncPolling.maxAttempts; attempt += 1) {
      await wait(linearSyncPolling.delayMs)
      if (!epochs.isLive(integration.id, epoch)) return
      const answer = await getJson(`/linear/${encodeURIComponent(integration.id)}/sync/${encodeURIComponent(runId)}`)
      if (!epochs.isLive(integration.id, epoch)) return
      if ("error" in answer) {
        /*
         * A transport drop carries no status: plue's run keeps syncing, so
         * the read is retried and only a budget spent on drops gives up,
         * with the header's last state standing (review finding 3). A
         * server that REFUSED the read is terminal, in its own words.
         */
        if (answer.status === null) {
          drops += 1
          if (drops <= linearSyncPolling.networkRetries) continue
          upsertSyncCard(integration, { trigger: LINEAR_LOST_STREAM_TRIGGER })
          settle()
          return
        }
        upsertSyncCard(integration, { error: answer.error })
        settle()
        return
      }
      drops = 0
      const run = parseRun(answer.body)
      if (run === null) {
        upsertSyncCard(integration, { error: "Smithers Cloud's answer for the Linear sync run was malformed." })
        settle()
        return
      }
      const feed = await readOps(integration.id, { limit: OPS_PAGE_LIMIT })
      if (!epochs.isLive(integration.id, epoch)) return
      upsertSyncCard(integration, {
        runState: run.state,
        counts: run.counts,
        ...("ops" in feed ? { ops: [...feed.ops], hasOlder: feed.nextCursor !== null, opsCursor: feed.nextCursor } : {})
      })
      if (RUN_SETTLED.has(run.state)) {
        settle()
        return
      }
    }
    settle()
  }

  /* ---- the acts ---- */

  const connect: LinearSeam["connect"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    clearSetup(cardIdOf(target.repo))
    upsertCard(cardIdOf(target.repo), target.repo, { phase: "setup", steps: freshSteps(target.repo) })
    return { value: `Connect Linear on ${target.repo} — the card walks the handoff.` }
  }

  const openLinear: LinearSeam["openLinear"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const repoId = target.repo
    const found = findCard(repoId)
    if (found === undefined) return `No Linear connect card for ${repoId} — /linear.connect opens it.`
    const { id } = found
    clearSetup(id)
    const prior = found.payload
    const readCard = (): SetupPayload | undefined => {
      const current = ctx.store.collections.cards.get(id)
      return current?.kind === "connector-setup" ? current.payload : undefined
    }
    /* The handoff: the local origin listens for the setup key. */
    let response: Response
    try {
      response = await ctx.http(`${ctx.baseUrl}${LINEAR_AUTH_START_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    } catch (error) {
      const message = `Could not reach the local app to start the Linear authorization: ${error instanceof Error ? error.message : String(error)}`
      upsertCard(id, repoId, { steps: patchStep(prior.steps, "authorize", { state: "error", error: message }) })
      return message
    }
    if (!response.ok) {
      const message = await readErrorMessage(response, `The Linear authorization couldn't start (${response.status}).`)
      upsertCard(id, repoId, { steps: patchStep(prior.steps, "authorize", { state: "error", error: message }) })
      return message
    }
    const started = LinearAuthStartResponseSchema.safeParse(await response.json().catch(() => null))
    if (!started.success) {
      const message = "The local app answered the Linear authorization with an unreadable payload."
      upsertCard(id, repoId, { steps: patchStep(prior.steps, "authorize", { state: "error", error: message }) })
      return message
    }
    if (deps.openExternal !== undefined) void deps.openExternal(started.data.url)
    else if (typeof window !== "undefined") window.open(started.data.url, "_blank", "noopener")
    /* Poll the local receiver for the setup key. */
    const deadline = Date.now() + timeoutMs
    let setupKey: string | null = null
    for (;;) {
      await wait(pollMs)
      try {
        const sessionResponse = await ctx.http(`${ctx.baseUrl}${LINEAR_AUTH_SESSION_PATH}`)
        if (sessionResponse.ok) {
          const session = LinearAuthSessionSchema.safeParse(await sessionResponse.json().catch(() => null))
          if (session.success && session.data.state === "authorized" && session.data.setupKey !== undefined) {
            setupKey = session.data.setupKey
            break
          }
        }
      } catch {
        // A dropped poll is retried until the deadline; the listener is still up.
      }
      if (Date.now() > deadline) break
    }
    if (setupKey === null) {
      const current = readCard() ?? prior
      upsertCard(id, repoId, { steps: patchStep(current.steps, "authorize", { state: "error", error: HANDOFF_TIMEOUT_NOTE }) })
      return HANDOFF_TIMEOUT_NOTE
    }
    /* The setup lookup: the teams the key can see. */
    const answer = await getJson(`/linear/setup/${encodeURIComponent(setupKey)}`, "/linear/setup")
    if ("error" in answer) {
      const current = readCard() ?? prior
      /* plue's own words for a spent or aged-out key: "linear oauth setup not found or expired". */
      const expired = /setup/i.test(answer.error) && /(expired|not found)/i.test(answer.error)
      const message = expired ? SETUP_EXPIRED_NOTE : redactSetupError(answer.error, setupKey)
      upsertCard(id, repoId, {
        steps: patchStep(current.steps, "authorize", { state: "error", error: message })
      })
      return message
    }
    const setup = parseSetup(answer.body)
    if (setup === null) {
      const current = readCard() ?? prior
      const message = "Smithers Cloud's answer for the Linear setup was malformed."
      upsertCard(id, repoId, { steps: patchStep(current.steps, "authorize", { state: "error", error: message }) })
      return message
    }
    const parsedExpiry = setup.expiresAt === null ? NaN : Date.parse(setup.expiresAt)
    const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : now() + timeoutMs
    if (expiresAt <= now()) {
      const current = readCard() ?? prior
      upsertCard(id, repoId, { steps: patchStep(current.steps, "authorize", { state: "error", error: SETUP_EXPIRED_NOTE }) })
      return SETUP_EXPIRED_NOTE
    }
    const current = readCard() ?? prior
    rememberSetup(id, setupKey, expiresAt)
    upsertCard(id, repoId, {
      setupExpiresAt: new Date(expiresAt).toISOString(),
      actor: setup.actor,
      teams: [...setup.teams],
      steps: patchStep(
        patchStep(current.steps, "authorize", { state: "done", error: undefined, detail: setup.actor === null ? "authorized" : `authorized as ${setup.actor}` }),
        "team",
        { state: "active" }
      )
    })
    return
  }

  const pickTeam: LinearSeam["pickTeam"] = async (teamId, repo) => {
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const found = findCard(target.repo)
    if (found === undefined) return `No Linear connect card for ${target.repo} — /linear.connect opens it.`
    const prior = found.payload
    const team = prior.teams?.find((candidate) => candidate.id === teamId)
    if (team === undefined) return `Team ${teamId} is not one this authorization can see.`
    upsertCard(found.id, prior.repo, {
      teamId: team.id,
      steps: patchStep(
        patchStep(prior.steps, "team", { state: "done", detail: `${team.key} · ${team.name}` }),
        "repository",
        { state: "active" }
      )
    })
    return
  }

  const pickRepository: LinearSeam["pickRepository"] = async (cardRepo, repo) => {
    const found = findCard(cardRepo)
    if (found === undefined) return `No Linear connect card for ${cardRepo} — /linear.connect opens it.`
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    /* The card id stays where the wizard was opened; the repository the
       create posts (and the title) follows the pick. */
    upsertCard(found.id, target.repo, {
      steps: patchStep(found.payload.steps, "repository", { detail: target.repo, state: "active" })
    })
    return
  }

  const confirmConnect: LinearSeam["confirmConnect"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const found = findCard(target.repo)
    if (found === undefined) return `No Linear connect card for ${target.repo} — /linear.connect opens it.`
    const prior = found.payload
    if (prior.phase === "setup" && prior.setupExpiresAt !== undefined && Date.parse(prior.setupExpiresAt) <= now()) {
      clearSetup(found.id)
      upsertCard(found.id, prior.repo, {
        steps: patchStep(prior.steps, "authorize", { state: "error", detail: null, error: SETUP_EXPIRED_NOTE })
      })
      return SETUP_EXPIRED_NOTE
    }
    const setup = setups.get(found.id)
    if (setup === undefined) {
      if (prior.phase === "setup") upsertCard(found.id, prior.repo, {
        steps: patchStep(prior.steps, "authorize", { state: "active", detail: null, error: undefined })
      })
      return "Step 1 first: Open Linear and authorize."
    }
    if (prior.teamId === undefined) return "Step 2 first: pick the Linear team."
    // A create consumes this attempt, even if its response is refused or malformed.
    clearSetup(found.id)
    const created = await sendJson("POST", "/linear", {
      setup_key: setup.key,
      linear_team_id: prior.teamId,
      repo: prior.repo
    })
    if ("error" in created) {
      const message = redactSetupError(created.error, setup.key)
      upsertCard(found.id, prior.repo, {
        error: message,
        steps: patchStep(prior.steps, "authorize", { state: "active", detail: null, error: undefined })
      })
      return message
    }
    await refreshIntegrations()
    const row = [...ctx.store.collections.linearIntegrations.values()].find(
      (candidate) => linearIntegrationRepo(candidate) === prior.repo && candidate.teamId === prior.teamId
    )
    /* The create's echo names no team KEY (plue answers id/name/repo/active
       only), so the key comes off the refreshed row, else the picked team. */
    const wire = isRecord(created.body) ? created.body : {}
    const integrationId = intOrNull(wire.id) ?? (row === undefined ? null : intOrNull(Number(row.id)))
    if (integrationId === null) {
      const message = "Smithers Cloud created the Linear integration without naming an integration id."
      upsertCard(found.id, prior.repo, {
        error: message,
        steps: patchStep(prior.steps, "authorize", { state: "active", detail: null, error: undefined })
      })
      return message
    }
    upsertCard(found.id, prior.repo, {
      phase: "connected",
      error: undefined,
      /* plue#491: the 201 echoes `linear_actor`, so a card that skipped the wizard's step 1 still names the account. */
      ...(linearActorName(wire.linear_actor) === null ? {} : { actor: linearActorName(wire.linear_actor) }),
      integration: {
        id: integrationId,
        teamKey: str(wire.linear_team_key) ?? row?.teamKey ?? prior.teams?.find((team) => team.id === prior.teamId)?.key ?? "",
        teamName: str(wire.linear_team_name) ?? row?.teamName ?? "",
        active: wire.is_active !== false,
        lastSyncAt: row?.lastSyncAt ?? null
      },
      steps: LINEAR_STEP_LABELS.map(([id, label]) => ({
        id,
        label,
        state: "done" as const,
        detail: id === "repository" ? prior.repo : (prior.steps.find((step) => step.id === id)?.detail ?? null)
      }))
    })
    return { value: `Linear ${row?.teamKey ?? ""} connected to ${prior.repo} — the card tracks it.` }
  }

  const syncNow: LinearSeam["syncNow"] = async (integration) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = await resolveIntegration(integration)
    if ("error" in resolved) return resolved.error
    const row = resolved.integration
    let response: Response
    try {
      response = await ctx.http(cloud(`/linear/${encodeURIComponent(row.id)}/sync`), { method: "POST" })
    } catch (error) {
      const message = `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}`
      upsertSyncCard(row, { error: message })
      return message
    }
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      /*
       * plue refuses a second concurrent run with 409 "linear sync already
       * running" and an inactive integration with 409 "linear integration is
       * inactive". Both are its own sentence and both read verbatim; the
       * card keeps whatever run it was already tracking.
       */
      const message = (isRecord(body) && typeof body.message === "string" && body.message !== ""
        ? body.message.slice(0, 240)
        : null) ?? `Starting the sync failed (${response.status})`
      upsertSyncCard(row, { error: message })
      return message
    }
    const runId = isRecord(body) ? intOrNull(body.run_id) : null
    if (runId === null) {
      const message = "Smithers Cloud started the sync without naming a run id."
      upsertSyncCard(row, { error: message })
      return message
    }
    const id = String(runId)
    /* A new run inherits nothing: not the last run's counts, ops, window or cut. */
    upsertSyncCard(row, {
      runId: id,
      runState: null,
      counts: null,
      ops: [],
      trigger: `sync started · run ${id}`
    }, { reset: true })
    void trackRun(row, id, epochs.start(row.id))
    return { value: `Sync run ${id} started for Linear ${row.teamKey} ↔ ${linearIntegrationRepo(row)} — the card tracks it.` }
  }

  const activity: LinearSeam["activity"] = async (integration) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = await resolveIntegration(integration)
    if ("error" in resolved) return resolved.error
    const row = resolved.integration
    const since = new Date(now() - 24 * 60 * 60 * 1000).toISOString()
    const feed = await readOps(row.id, { since, limit: OPS_PAGE_LIMIT })
    if ("error" in feed) {
      upsertSyncCard(row, { window: "24h", error: feed.error })
      return feed.error
    }
    upsertSyncCard(row, {
      window: "24h",
      ops: [...feed.ops],
      hasOlder: feed.nextCursor !== null,
      opsCursor: feed.nextCursor,
      trigger: null,
      error: undefined
    })
    return {
      value: `${feed.ops.length} Linear ${row.teamKey} sync ops in the last 24 hours — the card lists them.`
    }
  }

  const disconnect: LinearSeam["disconnect"] = async (integration, confirmKey) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    if (integration.trim() === "") return "linear.disconnect needs an integration: /linear.disconnect <id|team> <teamKey>"
    const resolved = await resolveIntegration(integration)
    if ("error" in resolved) return resolved.error
    const row = resolved.integration
    const repo = linearIntegrationRepo(row)
    /*
     * The typed-key gate lives HERE, not only in the card's chrome (the
     * workspace delete's rule): a slash, an agent's confirmed invocation, and
     * the card's second click all arrive with the key the invoker typed, and
     * only the integration's own team key disconnects. A row the wire left
     * without a key takes its id instead — never an empty match.
     */
    const expected = row.teamKey !== "" ? row.teamKey : row.id
    if ((confirmKey ?? "").trim() !== expected) {
      return `Disconnecting Linear ${row.teamKey} from ${repo} needs its team key typed back exactly — /linear.disconnect ${row.id} ${expected}.`
    }
    const removed = await sendJson("DELETE", `/integrations/linear/${encodeURIComponent(row.id)}`)
    if ("error" in removed) return removed.error
    /* A run this card was tracking has nothing left to track. */
    epochs.cancel(row.id)
    await refreshIntegrations()
    /*
     * A disconnected card leaves the transcript: any state it could show now
     * would be a lie. The connected card carries the integration's id; a
     * wizard opened on another repository and pointed here at step 3 is
     * still found through its payload.
     */
    const connected = [...ctx.store.collections.cards.values()].find(
      (card) => card.kind === "connector-setup" && card.payload.connector === "linear" && card.payload.integration?.id === Number(row.id)
    )
    const cardId = connected?.id ?? findCard(repo)?.id
    if (cardId !== undefined) {
      ctx.dispatch({ type: "card.removed", actor: ctx.actor(), id: cardId })
    }
    return { value: `Linear ${row.teamKey} disconnected from ${repo}.` }
  }

  /** The sync-ops card that carries one op, and the integration id it belongs to. */
  const cardForOp = (opId: string): { readonly card: Card & { kind: "sync-ops" }; readonly integrationId: string } | undefined => {
    for (const card of ctx.store.collections.cards.values()) {
      if (card.kind !== "sync-ops") continue
      const integrationId = card.payload.integrationId
      if (integrationId === undefined) continue
      if (card.payload.ops.some((op) => op.id === opId)) return { card, integrationId }
    }
    return undefined
  }

  const retryOp: LinearSeam["retryOp"] = async (opId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const trimmed = opId.trim()
    if (trimmed === "") return "sync.retry needs an op id: /sync.retry <opId>"
    /*
     * plue's retry route is per integration (`/api/linear/{id}/ops/{opId}/
     * retry`), and `sync.retry <opId>` names only the op — so the card that
     * lists the op names its integration. No card, no call.
     */
    const found = cardForOp(trimmed)
    if (found === undefined) {
      return `No sync card lists op ${trimmed} — the Retry button lives on the failed op's row.`
    }
    const { integrationId } = found
    const sent = await sendJson("POST", `/linear/${encodeURIComponent(integrationId)}/ops/${encodeURIComponent(trimmed)}/retry`)
    const row = ctx.store.collections.linearIntegrations.get(integrationId)
    if ("error" in sent) {
      /* plue refuses a non-failed op with 409 "only failed linear sync operations can be retried". */
      if (row !== undefined) upsertSyncCard(row, { error: sent.error })
      return sent.error
    }
    if (row === undefined) return { value: `Op ${trimmed} queued for retry.` }
    const feed = await readOps(integrationId, { limit: OPS_PAGE_LIMIT })
    if ("error" in feed) {
      upsertSyncCard(row, { error: feed.error })
      return feed.error
    }
    upsertSyncCard(row, { ops: [...feed.ops], hasOlder: feed.nextCursor !== null, opsCursor: feed.nextCursor, error: undefined })
    return { value: `Op ${trimmed} retried — the card lists the retry.` }
  }

  const showMoreOps: LinearSeam["showMoreOps"] = async (cardId) => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card === undefined || card.kind !== "sync-ops") return `No sync card ${cardId}.`
    ctx.dispatch({
      type: "card.upsert",
      actor: ctx.actor(),
      card: { ...card, payload: { ...card.payload, expanded: true } }
    })
    return undefined
  }

  const loadOlderOps: LinearSeam["loadOlderOps"] = async (cardId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const card = ctx.store.collections.cards.get(cardId)
    if (card === undefined || card.kind !== "sync-ops") return `No sync card ${cardId}.`
    const integrationId = card.payload.integrationId
    if (integrationId === undefined) return `Sync card ${cardId} names no Linear integration.`
    const row = ctx.store.collections.linearIntegrations.get(integrationId)
    if (row === undefined) return `Linear integration ${integrationId} is no longer connected.`
    /*
     * plue#491: older means the NEXT keyset page, continued from the cursor
     * the last page named — so the rows APPEND rather than replacing the
     * window with a wider re-read. A card with no cursor has nothing older
     * to fetch; that is the exhausted feed, not an error.
     */
    const cursor = card.payload.opsCursor ?? null
    if (cursor === null) return `The Linear ${row.teamKey} sync feed has no older page — the card lists all of it.`
    const feed = await readOps(integrationId, { limit: OPS_OLDER_LIMIT, cursor })
    if ("error" in feed) {
      upsertSyncCard(row, { error: feed.error })
      return feed.error
    }
    const seen = new Set(card.payload.ops.map((op) => op.id))
    const appended = [...card.payload.ops, ...feed.ops.filter((op) => !seen.has(op.id))]
    upsertSyncCard(row, {
      ops: appended,
      expanded: true,
      hasOlder: feed.nextCursor !== null,
      opsCursor: feed.nextCursor,
      error: undefined
    }, { clearWindow: true })
    return undefined
  }

  return {
    connect,
    openLinear,
    pickTeam,
    pickRepository,
    confirmConnect,
    refreshIntegrations,
    syncNow,
    activity,
    disconnect,
    retryOp,
    showMoreOps,
    loadOlderOps
  }
}
